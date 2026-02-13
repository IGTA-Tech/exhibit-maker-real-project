/**
 * Google Drive Import Routes
 * Lets users pick files from their own Google Drive via Google Picker,
 * then downloads them server-side so they can be added as exhibits.
 *
 * Required environment variables:
 *   GOOGLE_CLIENT_ID   – OAuth 2.0 Client ID (Web application type)
 *   GOOGLE_API_KEY     – API key with Google Picker API enabled
 *
 * Setup steps:
 *   1. Go to https://console.cloud.google.com/
 *   2. Create or select a project
 *   3. Enable "Google Drive API" and "Google Picker API"
 *   4. Create OAuth 2.0 Client ID (Web application)
 *      - Add your domain to Authorized JavaScript origins
 *      - e.g. http://localhost:3000 for dev
 *   5. Create an API key
 *      - Restrict it to "Google Picker API" under API restrictions
 *   6. Set GOOGLE_CLIENT_ID and GOOGLE_API_KEY in your .env
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

/**
 * Return the Google client config needed by the frontend Picker.
 * The frontend needs the Client ID and API Key but should not
 * have them hardcoded — this endpoint provides them from env vars.
 *
 * GET /api/drive/config
 */
router.get('/config', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const apiKey = process.env.GOOGLE_API_KEY;

  if (!clientId || !apiKey) {
    return res.json({
      available: false,
      message: 'Google Drive import not configured. Set GOOGLE_CLIENT_ID and GOOGLE_API_KEY.',
    });
  }

  res.json({
    available: true,
    clientId,
    apiKey,
    // Scopes needed for read-only file picking + download
    scope: 'https://www.googleapis.com/auth/drive.readonly',
  });
});

/**
 * Import files from Google Drive.
 * The frontend sends the user's OAuth access token and an array of
 * file descriptors returned by Google Picker. We download each file
 * using the Drive API and save it locally.
 *
 * POST /api/drive/import
 * Body: {
 *   accessToken: string,
 *   files: [{ id, name, mimeType, sizeBytes? }]
 * }
 */
router.post('/import', async (req, res) => {
  try {
    const { accessToken, files } = req.body;

    if (!accessToken) {
      return res.status(400).json({ error: 'accessToken is required' });
    }

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'files array is required' });
    }

    // Limit
    if (files.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 files per import' });
    }

    const allowedMimeTypes = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      // Google Docs can be exported as PDF
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.spreadsheet',
      'application/vnd.google-apps.presentation',
    ];

    const googleDocTypes = [
      'application/vnd.google-apps.document',
      'application/vnd.google-apps.spreadsheet',
      'application/vnd.google-apps.presentation',
    ];

    const results = [];

    for (const file of files) {
      try {
        if (!file.id || !file.name) {
          results.push({
            id: file.id,
            name: file.name,
            success: false,
            error: 'Missing file id or name',
          });
          continue;
        }

        // Check MIME type
        if (!allowedMimeTypes.includes(file.mimeType)) {
          results.push({
            id: file.id,
            name: file.name,
            success: false,
            error: `Unsupported file type: ${file.mimeType}. Use PDF, JPEG, or PNG.`,
          });
          continue;
        }

        let downloadUrl;
        let outputExt;

        if (googleDocTypes.includes(file.mimeType)) {
          // Google Docs/Sheets/Slides → export as PDF
          downloadUrl = `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=application/pdf`;
          outputExt = '.pdf';
        } else {
          // Binary files (PDF, images) → direct download
          downloadUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
          outputExt = path.extname(file.name).toLowerCase() || '.pdf';
        }

        // Download the file using the user's access token
        const response = await fetch(downloadUrl, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'Unknown error');
          let errorMsg = `Download failed (${response.status})`;

          if (response.status === 401) {
            errorMsg = 'Access token expired. Please reconnect Google Drive.';
          } else if (response.status === 403) {
            errorMsg = 'No permission to access this file.';
          } else if (response.status === 404) {
            errorMsg = 'File not found on Google Drive.';
          }

          results.push({
            id: file.id,
            name: file.name,
            success: false,
            error: errorMsg,
          });
          continue;
        }

        // Save to uploads directory
        const localFilename = `${uuidv4()}${outputExt}`;
        const localPath = path.join(uploadsDir, localFilename);

        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(localPath, buffer);

        const stats = fs.statSync(localPath);

        // Determine exhibit type
        let exhibitType = 'pdf';
        if (['.jpg', '.jpeg', '.png'].includes(outputExt)) {
          exhibitType = 'image';
        }

        results.push({
          id: file.id,
          name: file.name,
          success: true,
          localFilename,
          localPath,
          size: stats.size,
          type: exhibitType,
          originalMimeType: file.mimeType,
          wasConverted: googleDocTypes.includes(file.mimeType),
        });

        console.log(`Drive import: Downloaded ${file.name} (${formatBytes(stats.size)})`);
      } catch (err) {
        console.error(`Drive import error for ${file.name}:`, err.message);
        results.push({
          id: file.id,
          name: file.name,
          success: false,
          error: err.message,
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failedCount = results.filter(r => !r.success).length;

    res.json({
      success: true,
      imported: successCount,
      failed: failedCount,
      files: results,
    });
  } catch (error) {
    console.error('Drive import error:', error);
    res.status(500).json({ error: 'Failed to import files from Google Drive' });
  }
});

/**
 * Clean up a downloaded Drive file (called after it's been processed)
 * DELETE /api/drive/cleanup/:filename
 */
router.delete('/cleanup/:filename', (req, res) => {
  try {
    const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
    const filePath = path.join(uploadsDir, filename);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

module.exports = router;