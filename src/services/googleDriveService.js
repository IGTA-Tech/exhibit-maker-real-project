const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

let driveClient = null;

/**
 * Get credentials from environment or file
 * Supports base64 encoded credentials for production deployments
 */
function getCredentials() {
  // First try base64 encoded credentials (for Railway/cloud deployments)
  if (process.env.GOOGLE_CREDENTIALS_BASE64) {
    try {
      const decoded = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf8');
      return JSON.parse(decoded);
    } catch (error) {
      console.error('Failed to decode GOOGLE_CREDENTIALS_BASE64:', error.message);
    }
  }

  // Fall back to file-based credentials
  const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json';

  if (!fs.existsSync(credentialsPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  } catch (error) {
    console.error('Failed to read credentials file:', error.message);
    return null;
  }
}

/**
 * Get OAuth token from environment or file
 */
function getToken() {
  // Try base64 encoded token (for Railway/cloud deployments)
  if (process.env.GOOGLE_TOKEN_BASE64) {
    try {
      const decoded = Buffer.from(process.env.GOOGLE_TOKEN_BASE64, 'base64').toString('utf8');
      return JSON.parse(decoded);
    } catch (error) {
      console.error('Failed to decode GOOGLE_TOKEN_BASE64:', error.message);
    }
  }

  // Fall back to file-based token
  const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json';
  const tokenPath = path.join(path.dirname(credentialsPath), 'token.json');

  if (!fs.existsSync(tokenPath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch (error) {
    console.error('Failed to read token file:', error.message);
    return null;
  }
}

/**
 * Initialize Google Drive client
 * Supports both Service Account and OAuth2 credentials
 */
async function initializeDrive() {
  if (driveClient) return driveClient;

  const credentials = getCredentials();

  if (!credentials) {
    throw new Error('Google credentials not found. Set GOOGLE_CREDENTIALS_BASE64 or GOOGLE_CREDENTIALS_PATH.');
  }

  let auth;

  // Check if it's a service account or OAuth credentials
  if (credentials.type === 'service_account') {
    // Service Account credentials
    auth = new google.auth.GoogleAuth({
      credentials: credentials,
      scopes: ['https://www.googleapis.com/auth/drive.file']
    });
  } else if (credentials.installed || credentials.web) {
    // OAuth2 credentials - need token
    const token = getToken();

    if (!token) {
      throw new Error('OAuth token not found. Run the setup script first to authorize, or set GOOGLE_TOKEN_BASE64.');
    }

    const clientConfig = credentials.installed || credentials.web;

    const oauth2Client = new google.auth.OAuth2(
      clientConfig.client_id,
      clientConfig.client_secret,
      clientConfig.redirect_uris[0]
    );

    oauth2Client.setCredentials(token);
    auth = oauth2Client;
  } else {
    throw new Error('Invalid credentials format');
  }

  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

/**
 * Check if Google Drive is configured
 */
function isConfigured() {
  return !!(getCredentials());
}

/**
 * Create a folder in Google Drive
 */
async function createFolder(folderName, parentFolderId = null) {
  const drive = await initializeDrive();

  const fileMetadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder'
  };

  if (parentFolderId) {
    fileMetadata.parents = [parentFolderId];
  }

  const response = await drive.files.create({
    resource: fileMetadata,
    fields: 'id, name, webViewLink'
  });

  return {
    id: response.data.id,
    name: response.data.name,
    webViewLink: response.data.webViewLink
  };
}

/**
 * Upload a file to Google Drive
 */
async function uploadFile(filePath, fileName, folderId, mimeType = 'application/pdf') {
  const drive = await initializeDrive();

  const fileMetadata = {
    name: fileName,
    parents: folderId ? [folderId] : []
  };

  const media = {
    mimeType: mimeType,
    body: fs.createReadStream(filePath)
  };

  const response = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id, name, webViewLink'
  });

  return {
    id: response.data.id,
    name: response.data.name,
    webViewLink: response.data.webViewLink
  };
}

/**
 * Share a file or folder with an email address
 */
async function shareWithEmail(fileId, email, role = 'reader') {
  const drive = await initializeDrive();

  await drive.permissions.create({
    fileId: fileId,
    requestBody: {
      type: 'user',
      role: role,
      emailAddress: email
    },
    sendNotificationEmail: true,
    emailMessage: 'Your PDF files are ready! Click the link to access them.'
  });

  // Get the shareable link
  const file = await drive.files.get({
    fileId: fileId,
    fields: 'webViewLink'
  });

  return file.data.webViewLink;
}

/**
 * Upload multiple PDFs to a new shared folder
 */
async function uploadPdfsToSharedFolder(pdfFiles, folderName, recipientEmail) {
  if (!isConfigured()) {
    return {
      success: false,
      error: 'Google Drive not configured. Set GOOGLE_CREDENTIALS_BASE64 or GOOGLE_CREDENTIALS_PATH.'
    };
  }

  try {
    // Create folder
    const folder = await createFolder(folderName);
    console.log(`Created folder: ${folder.name} (${folder.id})`);

    // Upload all PDFs
    const uploadResults = [];
    for (const pdf of pdfFiles) {
      try {
        const result = await uploadFile(pdf.localPath, pdf.fileName, folder.id);
        uploadResults.push({
          success: true,
          fileName: pdf.fileName,
          fileId: result.id,
          webViewLink: result.webViewLink
        });
        console.log(`Uploaded: ${pdf.fileName}`);
      } catch (error) {
        uploadResults.push({
          success: false,
          fileName: pdf.fileName,
          error: error.message
        });
        console.error(`Failed to upload ${pdf.fileName}:`, error.message);
      }
    }

    // Share folder with recipient
    const shareLink = await shareWithEmail(folder.id, recipientEmail, 'reader');
    console.log(`Shared with ${recipientEmail}: ${shareLink}`);

    return {
      success: true,
      folderId: folder.id,
      folderName: folder.name,
      shareLink: shareLink,
      uploadedFiles: uploadResults.filter(r => r.success).length,
      failedFiles: uploadResults.filter(r => !r.success).length,
      results: uploadResults
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Create an index file and upload it
 */
async function uploadIndexFile(indexContent, folderId, fileName = 'INDEX.txt') {
  const drive = await initializeDrive();
  const { Readable } = require('stream');

  const fileMetadata = {
    name: fileName,
    parents: [folderId]
  };

  const media = {
    mimeType: 'text/plain',
    body: Readable.from([indexContent])
  };

  const response = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id, name, webViewLink'
  });

  return {
    id: response.data.id,
    name: response.data.name,
    webViewLink: response.data.webViewLink
  };
}

module.exports = {
  initializeDrive,
  isConfigured,
  createFolder,
  uploadFile,
  shareWithEmail,
  uploadPdfsToSharedFolder,
  uploadIndexFile
};
