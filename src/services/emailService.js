const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');

let transporter = null;

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  if (typeof text !== 'string') return text;
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * Get credentials from environment or file
 */
function getCredentials() {
  if (process.env.GOOGLE_CREDENTIALS_BASE64) {
    try {
      const decoded = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, 'base64').toString('utf8');
      return JSON.parse(decoded);
    } catch (error) {
      return null;
    }
  }

  const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json';
  if (!fs.existsSync(credentialsPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  } catch (error) {
    return null;
  }
}

/**
 * Get OAuth token from environment or file
 */
function getToken() {
  if (process.env.GOOGLE_TOKEN_BASE64) {
    try {
      const decoded = Buffer.from(process.env.GOOGLE_TOKEN_BASE64, 'base64').toString('utf8');
      return JSON.parse(decoded);
    } catch (error) {
      return null;
    }
  }

  const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json';
  const tokenPath = path.join(path.dirname(credentialsPath), 'token.json');
  if (!fs.existsSync(tokenPath)) return null;

  try {
    return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch (error) {
    return null;
  }
}

/**
 * Initialize email transporter
 */
async function initializeEmail() {
  if (transporter) return transporter;

  const credentials = getCredentials();
  const token = getToken();

  // Try Gmail OAuth2 first
  if (credentials && token && (credentials.installed || credentials.web)) {
    try {
      const clientConfig = credentials.installed || credentials.web;

      const oauth2Client = new google.auth.OAuth2(
        clientConfig.client_id,
        clientConfig.client_secret,
        clientConfig.redirect_uris[0]
      );

      oauth2Client.setCredentials(token);
      const accessToken = await oauth2Client.getAccessToken();

      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          type: 'OAuth2',
          user: process.env.EMAIL_USER || token.email || '',
          clientId: clientConfig.client_id,
          clientSecret: clientConfig.client_secret,
          refreshToken: token.refresh_token,
          accessToken: accessToken.token
        }
      });

      console.log('Email initialized with Gmail OAuth2');
      return transporter;
    } catch (error) {
      console.log('Gmail OAuth2 setup failed, falling back to SMTP:', error.message);
    }
  }

  // Fallback to regular SMTP
  const config = {
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD
    }
  };

  if (process.env.EMAIL_SERVICE) {
    config.service = process.env.EMAIL_SERVICE;
  } else if (process.env.EMAIL_HOST) {
    config.host = process.env.EMAIL_HOST;
    config.port = parseInt(process.env.EMAIL_PORT) || 587;
    config.secure = config.port === 465;
  } else {
    config.service = 'gmail';
  }

  transporter = nodemailer.createTransport(config);
  console.log('Email initialized with SMTP');
  return transporter;
}

/**
 * Check if email is configured
 */
function isConfigured() {
  return !!(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) || !!(getCredentials() && getToken());
}

/**
 * Get the base email styles (shared between templates)
 */
function getEmailStyles() {
  return `
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; 
      line-height: 1.6; 
      color: #333; 
      margin: 0; 
      padding: 0; 
      background-color: #f5f5f5;
    }
    .container { 
      max-width: 600px; 
      margin: 0 auto; 
      padding: 20px; 
    }
    .email-wrapper {
      background: #ffffff;
      border-radius: 12px;
      overflow: hidden;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    .header { 
      background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); 
      color: white; 
      padding: 30px; 
      text-align: center; 
    }
    .header-icon {
      font-size: 48px;
      margin-bottom: 10px;
    }
    .header h1 { 
      margin: 0 0 10px 0; 
      font-size: 24px; 
      font-weight: 600;
    }
    .header p { 
      margin: 0; 
      opacity: 0.9; 
      font-size: 14px;
    }
    .content { 
      background: #ffffff; 
      padding: 30px; 
    }
    .intro-text {
      color: #4b5563;
      font-size: 15px;
      margin-bottom: 25px;
    }
    .stats { 
      display: flex; 
      justify-content: space-around; 
      margin: 25px 0; 
      padding: 20px; 
      background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); 
      border-radius: 10px;
      border: 1px solid #e2e8f0;
    }
    .stat { 
      text-align: center;
      padding: 10px;
    }
    .stat-value { 
      font-size: 32px; 
      font-weight: 700; 
      color: #2563eb; 
      display: block;
      line-height: 1.2;
    }
    .stat-label { 
      font-size: 11px; 
      color: #64748b; 
      text-transform: uppercase; 
      letter-spacing: 0.5px;
      margin-top: 5px;
    }
    .attachment-section {
      text-align: center;
      margin: 30px 0;
      padding: 25px;
      background: linear-gradient(135deg, #ecfdf5 0%, #d1fae5 100%);
      border-radius: 10px;
      border: 2px dashed #10b981;
    }
    .attachment-icon {
      font-size: 40px;
      margin-bottom: 10px;
    }
    .attachment-text {
      color: #047857;
      font-weight: 600;
      font-size: 16px;
      margin: 0;
    }
    .attachment-hint {
      color: #6b7280;
      font-size: 13px;
      margin-top: 8px;
    }
    .download-section { 
      text-align: center; 
      margin: 30px 0; 
    }
    .download-btn { 
      display: inline-block; 
      background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); 
      color: white !important; 
      text-decoration: none; 
      padding: 16px 40px; 
      border-radius: 8px; 
      font-weight: 600; 
      font-size: 16px; 
      box-shadow: 0 4px 14px rgba(37, 99, 235, 0.4); 
    }
    .file-info { 
      background: #f8fafc; 
      padding: 20px; 
      border-radius: 10px; 
      margin: 20px 0;
      border: 1px solid #e2e8f0;
    }
    .file-info-title {
      font-size: 12px;
      text-transform: uppercase;
      color: #64748b;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
      font-weight: 600;
    }
    .file-info-row {
      display: flex;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #e2e8f0;
    }
    .file-info-row:last-child {
      border-bottom: none;
    }
    .file-info-label {
      color: #6b7280;
      font-size: 14px;
    }
    .file-info-value {
      color: #1f2937;
      font-weight: 500;
      font-size: 14px;
    }
    .success-badge {
      display: inline-block;
      background: #dcfce7;
      color: #166534;
      padding: 4px 12px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 500;
    }
    .expiry-notice { 
      background: #fef3c7; 
      border: 1px solid #f59e0b; 
      padding: 15px 20px; 
      border-radius: 10px; 
      margin: 20px 0; 
      font-size: 14px; 
      color: #92400e; 
    }
    .expiry-notice strong {
      color: #78350f;
    }
    .footer { 
      background: #1e293b; 
      color: #94a3b8; 
      padding: 25px; 
      text-align: center; 
      font-size: 12px; 
    }
    .footer p {
      margin: 5px 0;
    }
    .footer a { 
      color: #60a5fa; 
      text-decoration: none; 
    }
    .divider {
      height: 1px;
      background: linear-gradient(90deg, transparent, #e2e8f0, transparent);
      margin: 25px 0;
    }
  `;
}

/**
 * Send email with PDF attachment (beautiful template)
 */
async function sendEmailWithAttachment(recipientEmail, subject, attachmentPath, attachmentName, options = {}) {
  const mail = await initializeEmail();

  const {
    caseName = 'Your Documents',
    fileSize = 0,
    originalSize = 0,
    totalExhibits = 0,
    totalPages = 0,
    compressionApplied = false,
  } = options;

  // Get sender email
  let fromEmail = process.env.EMAIL_FROM || process.env.EMAIL_USER;
  if (!fromEmail) {
    const token = getToken();
    fromEmail = token?.email || 'noreply@example.com';
  }

  // Build HTML email
  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Your Exhibit Package</title>
      <style>${getEmailStyles()}</style>
    </head>
    <body>
      <div class="container">
        <div class="email-wrapper">
          <div class="header">
            <div class="header-icon">📁</div>
            <h1>Your Exhibit Package is Ready!</h1>
            <p>${escapeHtml(caseName)}</p>
          </div>
          
          <div class="content">
            <p class="intro-text">
              Great news! Your exhibit package has been generated successfully and is attached to this email.
            </p>
            
            <div class="stats">
              <div class="stat">
                <span class="stat-value">${totalExhibits || '—'}</span>
                <span class="stat-label">Exhibits</span>
              </div>
              <div class="stat">
                <span class="stat-value">${totalPages || '—'}</span>
                <span class="stat-label">Pages</span>
              </div>
              <div class="stat">
                <span class="stat-value">${formatBytes(fileSize)}</span>
                <span class="stat-label">File Size</span>
              </div>
            </div>

            <div class="attachment-section">
              <div class="attachment-icon">📎</div>
              <p class="attachment-text">File Attached Below</p>
              <p class="attachment-hint">Look for "${escapeHtml(attachmentName)}" in your email attachments</p>
            </div>

            <div class="file-info">
              <div class="file-info-title">📋 Package Details</div>
              <div class="file-info-row">
                <span class="file-info-label">File Name</span>
                <span class="file-info-value">${escapeHtml(attachmentName)}</span>
              </div>
              <div class="file-info-row">
                <span class="file-info-label">File Size</span>
                <span class="file-info-value">${formatBytes(fileSize)}${compressionApplied && originalSize ? ` <span class="success-badge">Compressed from ${formatBytes(originalSize)}</span>` : ''}</span>
              </div>
              ${totalExhibits ? `
              <div class="file-info-row">
                <span class="file-info-label">Total Exhibits</span>
                <span class="file-info-value">${totalExhibits}</span>
              </div>
              ` : ''}
              ${totalPages ? `
              <div class="file-info-row">
                <span class="file-info-label">Total Pages</span>
                <span class="file-info-value">${totalPages}</span>
              </div>
              ` : ''}
              <div class="file-info-row">
                <span class="file-info-label">Status</span>
                <span class="file-info-value"><span class="success-badge">✓ Ready to Download</span></span>
              </div>
            </div>

            <div class="divider"></div>

            <p style="color: #6b7280; font-size: 13px; text-align: center;">
              💡 <strong>Tip:</strong> If you don't see the attachment, check your spam folder or download it from your email provider's attachment viewer.
            </p>
          </div>

          <div class="footer">
            <p><strong>Exhibit Maker</strong></p>
            <p>Professional PDF Generation & Exhibit Packaging</p>
            <p style="margin-top: 15px; opacity: 0.7;">This is an automated message. Please do not reply directly to this email.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const mailOptions = {
    from: fromEmail,
    to: recipientEmail,
    subject: subject,
    html: htmlBody,
    attachments: [
      {
        filename: attachmentName,
        path: attachmentPath
      }
    ]
  };

  if (process.env.EMAIL_REPLY_TO) {
    mailOptions.replyTo = process.env.EMAIL_REPLY_TO;
  }

  try {
    const info = await mail.sendMail(mailOptions);
    return {
      success: true,
      messageId: info.messageId,
      response: info.response,
      method: 'attachment'
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Send email with download link (for large files)
 */
async function sendEmailWithDownloadLink(recipientEmail, subject, options = {}) {
  const mail = await initializeEmail();

  const {
    downloadUrl,
    fileName = 'Exhibit_Package.pdf',
    fileSize = 0,
    originalSize = 0,
    expiresAt = null,
    caseName = 'Your Documents',
    totalExhibits = 0,
    totalPages = 0,
    compressionApplied = false,
  } = options;

  // Get sender email
  let fromEmail = process.env.EMAIL_FROM || process.env.EMAIL_USER;
  if (!fromEmail) {
    const token = getToken();
    fromEmail = token?.email || 'noreply@example.com';
  }

  // Calculate expiry text
  let expiryText = '';
  let expiryDate = '';
  if (expiresAt) {
    const expiry = new Date(expiresAt);
    expiryDate = expiry.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    expiryText = `This download link will expire on ${expiryDate}.`;
  }

  // Build HTML email
  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Your Exhibit Package</title>
      <style>${getEmailStyles()}</style>
    </head>
    <body>
      <div class="container">
        <div class="email-wrapper">
          <div class="header">
            <div class="header-icon">📁</div>
            <h1>Your Exhibit Package is Ready!</h1>
            <p>${escapeHtml(caseName)}</p>
          </div>
          
          <div class="content">
            <p class="intro-text">
              Great news! Your exhibit package has been generated and is ready for download.
            </p>
            
            <div class="stats">
              <div class="stat">
                <span class="stat-value">${totalExhibits || '—'}</span>
                <span class="stat-label">Exhibits</span>
              </div>
              <div class="stat">
                <span class="stat-value">${totalPages || '—'}</span>
                <span class="stat-label">Pages</span>
              </div>
              <div class="stat">
                <span class="stat-value">${formatBytes(fileSize)}</span>
                <span class="stat-label">File Size</span>
              </div>
            </div>

            <div class="download-section">
              <a href="${escapeHtml(downloadUrl)}" class="download-btn">
                ⬇️ Download Package
              </a>
            </div>

            <div class="file-info">
              <div class="file-info-title">📋 Package Details</div>
              <div class="file-info-row">
                <span class="file-info-label">File Name</span>
                <span class="file-info-value">${escapeHtml(fileName)}</span>
              </div>
              <div class="file-info-row">
                <span class="file-info-label">File Size</span>
                <span class="file-info-value">${formatBytes(fileSize)}${compressionApplied && originalSize ? ` <span class="success-badge">Compressed from ${formatBytes(originalSize)}</span>` : ''}</span>
              </div>
              ${totalExhibits ? `
              <div class="file-info-row">
                <span class="file-info-label">Total Exhibits</span>
                <span class="file-info-value">${totalExhibits}</span>
              </div>
              ` : ''}
              ${totalPages ? `
              <div class="file-info-row">
                <span class="file-info-label">Total Pages</span>
                <span class="file-info-value">${totalPages}</span>
              </div>
              ` : ''}
              <div class="file-info-row">
                <span class="file-info-label">Status</span>
                <span class="file-info-value"><span class="success-badge">✓ Ready to Download</span></span>
              </div>
            </div>

            ${expiryText ? `
            <div class="expiry-notice">
              ⚠️ <strong>Important:</strong> ${expiryText} Please download your file before it expires.
            </div>
            ` : ''}

            <div class="divider"></div>

            <p style="color: #6b7280; font-size: 13px; text-align: center;">
              If the button above doesn't work, copy and paste this link into your browser:<br>
              <a href="${escapeHtml(downloadUrl)}" style="color: #2563eb; word-break: break-all; font-size: 12px;">${escapeHtml(downloadUrl)}</a>
            </p>
          </div>

          <div class="footer">
            <p><strong>Exhibit Maker</strong></p>
            <p>Professional PDF Generation & Exhibit Packaging</p>
            <p style="margin-top: 15px; opacity: 0.7;">This is an automated message. Please do not reply directly to this email.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const mailOptions = {
    from: fromEmail,
    to: recipientEmail,
    subject: subject,
    html: htmlBody,
  };

  if (process.env.EMAIL_REPLY_TO) {
    mailOptions.replyTo = process.env.EMAIL_REPLY_TO;
  }

  try {
    const info = await mail.sendMail(mailOptions);
    return {
      success: true,
      messageId: info.messageId,
      response: info.response,
      method: 'download_link'
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Create a ZIP file from multiple PDFs
 */
async function createZipFromPdfs(pdfFiles, outputPath, indexContent = null) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      resolve({
        path: outputPath,
        size: archive.pointer()
      });
    });

    archive.on('error', reject);
    archive.pipe(output);

    for (const pdf of pdfFiles) {
      if (fs.existsSync(pdf.localPath)) {
        archive.file(pdf.localPath, { name: pdf.fileName });
      }
    }

    if (indexContent) {
      archive.append(indexContent, { name: 'INDEX.txt' });
    }

    archive.finalize();
  });
}

/**
 * Legacy: Send email with ZIP attachment (basic template)
 */
async function sendEmailWithZip(recipientEmail, subject, htmlBody, zipPath, zipFileName) {
  const mail = await initializeEmail();

  let fromEmail = process.env.EMAIL_FROM || process.env.EMAIL_USER;
  if (!fromEmail) {
    const token = getToken();
    fromEmail = token?.email || 'noreply@example.com';
  }

  const mailOptions = {
    from: fromEmail,
    to: recipientEmail,
    subject: subject,
    html: htmlBody,
    attachments: [
      {
        filename: zipFileName,
        path: zipPath
      }
    ]
  };

  if (process.env.EMAIL_REPLY_TO) {
    mailOptions.replyTo = process.env.EMAIL_REPLY_TO;
  }

  try {
    const info = await mail.sendMail(mailOptions);
    return {
      success: true,
      messageId: info.messageId,
      response: info.response
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Legacy: Generate HTML email body
 */
function generateEmailHtml(results, folderName) {
  const successCount = results.success.length;
  const failedCount = results.failed.length;
  const totalCount = results.total;
  const safeFolderName = escapeHtml(folderName);

  let html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>${getEmailStyles()}</style>
    </head>
    <body>
      <div class="container">
        <div class="email-wrapper">
          <div class="header">
            <h1>Your PDFs are Ready!</h1>
            <p>${safeFolderName}</p>
          </div>
          <div class="content">
            <p class="intro-text">Your URL to PDF conversion is complete. Please find the attached ZIP file containing your PDFs.</p>
            <div class="stats">
              <div class="stat">
                <span class="stat-value">${totalCount}</span>
                <span class="stat-label">Total URLs</span>
              </div>
              <div class="stat">
                <span class="stat-value" style="color: #16a34a;">${successCount}</span>
                <span class="stat-label">Converted</span>
              </div>
              <div class="stat">
                <span class="stat-value" style="color: #dc2626;">${failedCount}</span>
                <span class="stat-label">Failed</span>
              </div>
            </div>
  `;

  if (failedCount > 0) {
    html += `
            <div class="file-info">
              <div class="file-info-title">⚠️ Failed Conversions</div>
    `;
    results.failed.forEach(item => {
      const safeUrl = escapeHtml(item.url.substring(0, 50));
      const safeError = escapeHtml(item.error);
      html += `
              <div class="file-info-row">
                <span class="file-info-label">#${item.index}: ${safeUrl}...</span>
                <span class="file-info-value" style="color: #dc2626;">${safeError}</span>
              </div>
      `;
    });
    html += `</div>`;
  }

  html += `
          </div>
          <div class="footer">
            <p><strong>Exhibit Maker</strong></p>
            <p>This is an automated message.</p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  return html;
}

/**
 * Send PDFs via email as ZIP attachment
 */
async function sendPdfsViaEmail(pdfFiles, recipientEmail, folderName, results, indexContent) {
  if (!isConfigured()) {
    return {
      success: false,
      error: 'Email not configured. Set EMAIL_USER and EMAIL_PASSWORD, or configure Google OAuth.'
    };
  }

  const tempDir = path.join(__dirname, '../../temp');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const zipFileName = `${folderName.replace(/[^a-z0-9]/gi, '_')}.zip`;
  const zipPath = path.join(tempDir, zipFileName);

  try {
    console.log('Creating ZIP file...');
    const zip = await createZipFromPdfs(pdfFiles, zipPath, indexContent);
    console.log(`ZIP created: ${(zip.size / 1024 / 1024).toFixed(2)} MB`);

    const maxSize = 25 * 1024 * 1024;
    if (zip.size > maxSize) {
      fs.unlinkSync(zipPath);
      return {
        success: false,
        error: `ZIP file too large (${(zip.size / 1024 / 1024).toFixed(2)} MB). Maximum is 25MB.`
      };
    }

    const htmlBody = generateEmailHtml(results, folderName);

    console.log(`Sending email to ${recipientEmail}...`);
    const emailResult = await sendEmailWithZip(
      recipientEmail,
      `Your PDFs are Ready: ${escapeHtml(folderName)}`,
      htmlBody,
      zipPath,
      zipFileName
    );

    fs.unlinkSync(zipPath);
    return emailResult;
  } catch (error) {
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  initializeEmail,
  isConfigured,
  createZipFromPdfs,
  sendEmailWithZip,
  sendEmailWithAttachment,
  sendEmailWithDownloadLink,
  sendPdfsViaEmail,
  generateEmailHtml,
  escapeHtml,
  formatBytes
};