const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');

const pdfService = require('../services/pdfService');
const googleDriveService = require('../services/googleDriveService');
const emailService = require('../services/emailService');
const jobStorage = require('../services/jobStorageService');

// Initialize job storage on module load
jobStorage.initialize();

// Cleanup old jobs every hour
setInterval(() => {
  jobStorage.cleanupOldJobs(24);
}, 60 * 60 * 1000);

// Validation middleware
const convertValidation = [
  body('recipientEmail')
    .isEmail()
    .withMessage('Valid email address is required')
    .normalizeEmail(),
  body('deliveryMethod')
    .isIn(['email', 'drive'])
    .withMessage('Delivery method must be "email" or "drive"'),
  body('folderName')
    .optional()
    .isString()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Folder name must be less than 100 characters'),
];

/**
 * Validate URL format
 */
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Sanitize string for display (prevent XSS)
 */
function sanitizeString(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Start a new PDF conversion job
 * POST /api/pdf/convert
 */
router.post('/convert', convertValidation, async (req, res) => {
  try {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array().map(e => e.msg),
      });
    }

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
      urlList = urls
        .filter(url => {
          const urlStr = typeof url === 'string' ? url : url?.url;
          return urlStr && isValidUrl(urlStr);
        })
        .map((url, idx) => ({
          url: typeof url === 'string' ? url : url.url,
          label: typeof url === 'object' ? sanitizeString(url.label || '') : '',
          fileName: typeof url === 'object' && url.fileName
            ? sanitizeString(url.fileName)
            : `PDF_${String(idx + 1).padStart(3, '0')}.pdf`,
        }));
    } else if (urlText) {
      // Text with URLs
      urlList = pdfService.parseUrls(urlText, 'text');
    }

    if (urlList.length === 0) {
      return res.status(400).json({ error: 'No valid URLs provided' });
    }

    // Limit number of URLs per job
    const maxUrls = 100;
    if (urlList.length > maxUrls) {
      return res.status(400).json({
        error: `Too many URLs. Maximum ${maxUrls} URLs per job.`,
      });
    }

    // Create job
    const jobId = uuidv4();
    const jobFolderName = folderName || `PDFs_${new Date().toISOString().split('T')[0]}_${jobId.substring(0, 8)}`;
    const tempDir = path.join(__dirname, '../../temp', jobId);

    fs.mkdirSync(tempDir, { recursive: true });

    // Create job in storage
    const job = await jobStorage.createJob({
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
      createdAt: new Date().toISOString(),
    });

    // Start processing in background
    processJob(jobId, urlList, tempDir, deliveryMethod, recipientEmail, jobFolderName);

    res.json({
      success: true,
      jobId,
      message: `Started processing ${urlList.length} URLs`,
      statusUrl: `/api/pdf/status/${jobId}`,
      persistent: jobStorage.isPersistent(),
    });

  } catch (error) {
    console.error('Error starting job:', error);
    res.status(500).json({ error: 'Failed to start conversion job' });
  }
});

/**
 * Get job status
 * GET /api/pdf/status/:jobId
 */
router.get('/status/:jobId', async (req, res) => {
  try {
    const job = await jobStorage.getJob(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json(job);
  } catch (error) {
    console.error('Error getting job status:', error);
    res.status(500).json({ error: 'Failed to get job status' });
  }
});

/**
 * List recent jobs
 * GET /api/pdf/jobs
 */
router.get('/jobs', async (req, res) => {
  try {
    const jobs = await jobStorage.getJobs({ limit: 50 });
    res.json(jobs);
  } catch (error) {
    console.error('Error listing jobs:', error);
    res.status(500).json({ error: 'Failed to list jobs' });
  }
});

/**
 * Process job in background
 */
async function processJob(jobId, urlList, tempDir, deliveryMethod, recipientEmail, folderName) {
  try {
    // Log start
    await jobStorage.addLog(jobId, 'Starting PDF conversion...');

    // Convert URLs to PDFs
    const results = await pdfService.processUrls(urlList, tempDir, async (progress) => {
      if (progress.type === 'batch') {
        const progressPercent = Math.round((progress.processed / progress.totalUrls) * 100);
        await jobStorage.updateJob(jobId, { progress: progressPercent });
        await jobStorage.addLog(jobId, `Processing batch ${progress.current}/${progress.total}`);
      } else if (progress.type === 'success') {
        const job = await jobStorage.getJob(jobId);
        await jobStorage.updateJob(jobId, {
          processedUrls: (job?.processedUrls || 0) + 1,
          successCount: (job?.successCount || 0) + 1,
        });
      } else if (progress.type === 'failed') {
        const job = await jobStorage.getJob(jobId);
        await jobStorage.updateJob(jobId, {
          processedUrls: (job?.processedUrls || 0) + 1,
          failedCount: (job?.failedCount || 0) + 1,
        });
        await jobStorage.addLog(jobId, `Failed: ${sanitizeString(progress.fileName)} - ${sanitizeString(progress.error)}`);
      }
    });

    await jobStorage.updateJob(jobId, { progress: 100 });
    await jobStorage.addLog(
      jobId,
      `Conversion complete: ${results.success.length} succeeded, ${results.failed.length} failed`
    );

    // Generate index content
    const indexContent = generateIndex(urlList, results, folderName);

    // Deliver based on method
    if (deliveryMethod === 'drive') {
      await jobStorage.updateJob(jobId, { status: 'uploading' });
      await jobStorage.addLog(jobId, 'Uploading to Google Drive...');

      const driveResult = await googleDriveService.uploadPdfsToSharedFolder(
        results.success,
        folderName,
        recipientEmail
      );

      if (driveResult.success) {
        // Upload index file
        await googleDriveService.uploadIndexFile(indexContent, driveResult.folderId);

        await jobStorage.updateJob(jobId, {
          status: 'completed',
          deliveryResult: {
            method: 'Google Drive',
            shareLink: driveResult.shareLink,
            uploadedFiles: driveResult.uploadedFiles,
          },
          completedAt: new Date().toISOString(),
        });
        await jobStorage.addLog(jobId, `Shared folder with ${recipientEmail}: ${driveResult.shareLink}`);
      } else {
        throw new Error(driveResult.error);
      }

    } else {
      await jobStorage.updateJob(jobId, { status: 'sending' });
      await jobStorage.addLog(jobId, 'Creating ZIP and sending email...');

      const emailResult = await emailService.sendPdfsViaEmail(
        results.success,
        recipientEmail,
        folderName,
        results,
        indexContent
      );

      if (emailResult.success) {
        await jobStorage.updateJob(jobId, {
          status: 'completed',
          deliveryResult: {
            method: 'Email',
            messageId: emailResult.messageId,
          },
          completedAt: new Date().toISOString(),
        });
        await jobStorage.addLog(jobId, `Email sent to ${recipientEmail}`);
      } else {
        throw new Error(emailResult.error);
      }
    }

  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    await jobStorage.updateJob(jobId, {
      status: 'failed',
      error: error.message,
    });
    await jobStorage.addLog(jobId, `Error: ${sanitizeString(error.message)}`);
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
