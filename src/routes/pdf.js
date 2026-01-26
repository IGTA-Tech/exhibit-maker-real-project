const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const pdfService = require('../services/pdfService');
const googleDriveService = require('../services/googleDriveService');
const emailService = require('../services/emailService');

// Store job status for polling
const jobs = new Map();

/**
 * Start a new PDF conversion job
 * POST /api/pdf/convert
 */
router.post('/convert', async (req, res) => {
  try {
    const { urls, urlText, deliveryMethod, recipientEmail, folderName } = req.body;
    let urlList = [];

    // Parse URLs from various sources
    if (req.file) {
      // File uploaded
      const fileContent = fs.readFileSync(req.file.path, 'utf8');
      const ext = path.extname(req.file.originalname).toLowerCase();
      urlList = pdfService.parseUrls(fileContent, ext === '.json' ? 'json' : 'text');
      // Clean up uploaded file
      fs.unlinkSync(req.file.path);
    } else if (urls && Array.isArray(urls)) {
      // Array of URLs provided
      urlList = urls.map((url, idx) => ({
        url: typeof url === 'string' ? url : url.url,
        label: typeof url === 'object' ? url.label : '',
        fileName: typeof url === 'object' && url.fileName ? url.fileName : `PDF_${String(idx + 1).padStart(3, '0')}.pdf`
      }));
    } else if (urlText) {
      // Text with URLs
      urlList = pdfService.parseUrls(urlText, 'text');
    }

    if (urlList.length === 0) {
      return res.status(400).json({ error: 'No valid URLs provided' });
    }

    if (!recipientEmail) {
      return res.status(400).json({ error: 'Recipient email is required' });
    }

    if (!deliveryMethod || !['email', 'drive'].includes(deliveryMethod)) {
      return res.status(400).json({ error: 'Invalid delivery method. Use "email" or "drive"' });
    }

    // Create job
    const jobId = uuidv4();
    const jobFolderName = folderName || `PDFs_${new Date().toISOString().split('T')[0]}_${jobId.substring(0, 8)}`;
    const tempDir = path.join(__dirname, '../../temp', jobId);

    fs.mkdirSync(tempDir, { recursive: true });

    // Initialize job status
    jobs.set(jobId, {
      id: jobId,
      status: 'processing',
      progress: 0,
      totalUrls: urlList.length,
      processedUrls: 0,
      successCount: 0,
      failedCount: 0,
      deliveryMethod,
      recipientEmail,
      folderName: jobFolderName,
      logs: [],
      createdAt: new Date().toISOString()
    });

    // Start processing in background
    processJob(jobId, urlList, tempDir, deliveryMethod, recipientEmail, jobFolderName);

    res.json({
      success: true,
      jobId,
      message: `Started processing ${urlList.length} URLs`,
      statusUrl: `/api/pdf/status/${jobId}`
    });

  } catch (error) {
    console.error('Error starting job:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get job status
 * GET /api/pdf/status/:jobId
 */
router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json(job);
});

/**
 * Process job in background
 */
async function processJob(jobId, urlList, tempDir, deliveryMethod, recipientEmail, folderName) {
  const job = jobs.get(jobId);

  try {
    // Convert URLs to PDFs
    job.logs.push({ time: new Date().toISOString(), message: 'Starting PDF conversion...' });

    const results = await pdfService.processUrls(urlList, tempDir, (progress) => {
      if (progress.type === 'batch') {
        job.progress = Math.round((progress.processed / progress.totalUrls) * 100);
        job.logs.push({
          time: new Date().toISOString(),
          message: `Processing batch ${progress.current}/${progress.total}`
        });
      } else if (progress.type === 'success') {
        job.processedUrls++;
        job.successCount++;
      } else if (progress.type === 'failed') {
        job.processedUrls++;
        job.failedCount++;
        job.logs.push({
          time: new Date().toISOString(),
          message: `Failed: ${progress.fileName} - ${progress.error}`
        });
      }
    });

    job.progress = 100;
    job.logs.push({
      time: new Date().toISOString(),
      message: `Conversion complete: ${results.success.length} succeeded, ${results.failed.length} failed`
    });

    // Generate index content
    const indexContent = generateIndex(urlList, results, folderName);

    // Deliver based on method
    if (deliveryMethod === 'drive') {
      job.status = 'uploading';
      job.logs.push({ time: new Date().toISOString(), message: 'Uploading to Google Drive...' });

      const driveResult = await googleDriveService.uploadPdfsToSharedFolder(
        results.success,
        folderName,
        recipientEmail
      );

      if (driveResult.success) {
        // Upload index file
        await googleDriveService.uploadIndexFile(indexContent, driveResult.folderId);

        job.status = 'completed';
        job.deliveryResult = {
          method: 'Google Drive',
          shareLink: driveResult.shareLink,
          uploadedFiles: driveResult.uploadedFiles
        };
        job.logs.push({
          time: new Date().toISOString(),
          message: `Shared folder with ${recipientEmail}: ${driveResult.shareLink}`
        });
      } else {
        throw new Error(driveResult.error);
      }

    } else {
      job.status = 'sending';
      job.logs.push({ time: new Date().toISOString(), message: 'Creating ZIP and sending email...' });

      const emailResult = await emailService.sendPdfsViaEmail(
        results.success,
        recipientEmail,
        folderName,
        results,
        indexContent
      );

      if (emailResult.success) {
        job.status = 'completed';
        job.deliveryResult = {
          method: 'Email',
          messageId: emailResult.messageId
        };
        job.logs.push({
          time: new Date().toISOString(),
          message: `Email sent to ${recipientEmail}`
        });
      } else {
        throw new Error(emailResult.error);
      }
    }

    job.completedAt = new Date().toISOString();

  } catch (error) {
    job.status = 'failed';
    job.error = error.message;
    job.logs.push({
      time: new Date().toISOString(),
      message: `Error: ${error.message}`
    });
  } finally {
    // Cleanup temp directory
    cleanupDir(tempDir);
  }
}

/**
 * Generate index content
 */
function generateIndex(urlList, results, folderName) {
  let content = `
================================================================================
PDF CONVERSION INDEX
================================================================================
Folder: ${folderName}
Generated: ${new Date().toISOString()}
Total URLs: ${urlList.length}
Successful: ${results.success.length}
Failed: ${results.failed.length}
================================================================================

SUCCESSFUL CONVERSIONS:
-----------------------
`;

  results.success.forEach(item => {
    content += `
[${String(item.index).padStart(3, '0')}] ${item.fileName}
     URL: ${item.url}
     ${item.label ? `Label: ${item.label}` : ''}
`;
  });

  if (results.failed.length > 0) {
    content += `

FAILED CONVERSIONS:
-------------------
`;
    results.failed.forEach(item => {
      content += `
[${String(item.index).padStart(3, '0')}] ${item.url}
     Error: ${item.error}
`;
    });
  }

  return content;
}

/**
 * Cleanup directory
 */
function cleanupDir(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
}

module.exports = router;
