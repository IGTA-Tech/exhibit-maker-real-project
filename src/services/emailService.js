const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');

let transporter = null;

/**
 * Initialize email transporter
 * Supports Gmail API (OAuth2) or regular SMTP
 */
async function initializeEmail() {
  if (transporter) return transporter;

  // Try Gmail API first if Google credentials exist
  const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH || './credentials.json';
  const tokenPath = path.join(path.dirname(credentialsPath), 'token.json');

  if (fs.existsSync(credentialsPath) && fs.existsSync(tokenPath)) {
    try {
      const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
      const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));

      // Check if it's OAuth credentials (not service account)
      if (credentials.installed || credentials.web) {
        const clientConfig = credentials.installed || credentials.web;

        const oauth2Client = new google.auth.OAuth2(
          clientConfig.client_id,
          clientConfig.client_secret,
          clientConfig.redirect_uris[0]
        );

        oauth2Client.setCredentials(token);

        // Get fresh access token
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
      }
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
    // Default to Gmail
    config.service = 'gmail';
  }

  transporter = nodemailer.createTransport(config);
  console.log('Email initialized with SMTP');
  return transporter;
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

    // Add each PDF to the archive
    for (const pdf of pdfFiles) {
      if (fs.existsSync(pdf.localPath)) {
        archive.file(pdf.localPath, { name: pdf.fileName });
      }
    }

    // Add index file if provided
    if (indexContent) {
      archive.append(indexContent, { name: 'INDEX.txt' });
    }

    archive.finalize();
  });
}

/**
 * Send email with ZIP attachment
 */
async function sendEmailWithZip(recipientEmail, subject, htmlBody, zipPath, zipFileName) {
  const mail = await initializeEmail();

  // Get sender email
  let fromEmail = process.env.EMAIL_USER;
  if (!fromEmail) {
    const tokenPath = './token.json';
    if (fs.existsSync(tokenPath)) {
      const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      fromEmail = token.email || 'noreply@example.com';
    }
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
 * Generate HTML email body
 */
function generateEmailHtml(results, folderName) {
  const successCount = results.success.length;
  const failedCount = results.failed.length;
  const totalCount = results.total;

  let html = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #2563eb; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
        .content { background: #f8fafc; padding: 20px; border: 1px solid #e2e8f0; }
        .stats { display: flex; gap: 20px; margin: 20px 0; }
        .stat { background: white; padding: 15px; border-radius: 8px; text-align: center; flex: 1; }
        .stat-number { font-size: 24px; font-weight: bold; }
        .success { color: #16a34a; }
        .failed { color: #dc2626; }
        .footer { background: #1e293b; color: #94a3b8; padding: 15px; text-align: center; border-radius: 0 0 8px 8px; font-size: 12px; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th, td { padding: 8px; text-align: left; border-bottom: 1px solid #e2e8f0; }
        th { background: #e2e8f0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1 style="margin: 0;">Your PDFs are Ready!</h1>
          <p style="margin: 10px 0 0 0; opacity: 0.9;">${folderName}</p>
        </div>
        <div class="content">
          <p>Your URL to PDF conversion is complete. Please find the attached ZIP file containing your PDFs.</p>

          <div class="stats">
            <div class="stat">
              <div class="stat-number">${totalCount}</div>
              <div>Total URLs</div>
            </div>
            <div class="stat">
              <div class="stat-number success">${successCount}</div>
              <div>Converted</div>
            </div>
            <div class="stat">
              <div class="stat-number failed">${failedCount}</div>
              <div>Failed</div>
            </div>
          </div>
  `;

  if (failedCount > 0) {
    html += `
          <h3>Failed Conversions:</h3>
          <table>
            <tr><th>#</th><th>URL</th><th>Error</th></tr>
    `;
    results.failed.forEach(item => {
      html += `<tr><td>${item.index}</td><td style="word-break: break-all; max-width: 250px;">${item.url.substring(0, 50)}...</td><td>${item.error}</td></tr>`;
    });
    html += `</table>`;
  }

  html += `
        </div>
        <div class="footer">
          Generated by URL to PDF Tool
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
  const tempDir = path.join(__dirname, '../../temp');

  // Ensure temp dir exists
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const zipFileName = `${folderName.replace(/[^a-z0-9]/gi, '_')}.zip`;
  const zipPath = path.join(tempDir, zipFileName);

  try {
    // Create ZIP file
    console.log('Creating ZIP file...');
    const zip = await createZipFromPdfs(pdfFiles, zipPath, indexContent);
    console.log(`ZIP created: ${(zip.size / 1024 / 1024).toFixed(2)} MB`);

    // Check file size (most email providers limit to 25MB)
    const maxSize = 25 * 1024 * 1024; // 25MB
    if (zip.size > maxSize) {
      // Clean up
      fs.unlinkSync(zipPath);
      return {
        success: false,
        error: `ZIP file too large (${(zip.size / 1024 / 1024).toFixed(2)} MB). Maximum is 25MB. Consider using Google Drive delivery instead.`
      };
    }

    // Generate email HTML
    const htmlBody = generateEmailHtml(results, folderName);

    // Send email
    console.log(`Sending email to ${recipientEmail}...`);
    const emailResult = await sendEmailWithZip(
      recipientEmail,
      `Your PDFs are Ready: ${folderName}`,
      htmlBody,
      zipPath,
      zipFileName
    );

    // Clean up ZIP file
    fs.unlinkSync(zipPath);

    return emailResult;
  } catch (error) {
    // Clean up on error
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
  createZipFromPdfs,
  sendEmailWithZip,
  sendPdfsViaEmail,
  generateEmailHtml
};
