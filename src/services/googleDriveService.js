const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

let driveClient = null;

/**
 * Initialize Google Drive client
 * Supports both Service Account and OAuth2 credentials
 */
async function initializeDrive() {
  if (driveClient) return driveClient;

  const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json';

  if (!fs.existsSync(credentialsPath)) {
    throw new Error(`Google credentials file not found at: ${credentialsPath}`);
  }

  const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

  let auth;

  // Check if it's a service account or OAuth credentials
  if (credentials.type === 'service_account') {
    // Service Account credentials
    auth = new google.auth.GoogleAuth({
      keyFile: credentialsPath,
      scopes: ['https://www.googleapis.com/auth/drive.file']
    });
  } else if (credentials.installed || credentials.web) {
    // OAuth2 credentials - need token
    const tokenPath = path.join(path.dirname(credentialsPath), 'token.json');

    if (!fs.existsSync(tokenPath)) {
      throw new Error('OAuth token not found. Run the setup script first to authorize.');
    }

    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
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
  createFolder,
  uploadFile,
  shareWithEmail,
  uploadPdfsToSharedFolder,
  uploadIndexFile
};
