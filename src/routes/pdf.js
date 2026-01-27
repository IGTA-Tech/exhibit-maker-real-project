const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const multer = require('multer');

const pdfService = require('../services/pdfService');
const googleDriveService = require('../services/googleDriveService');
const emailService = require('../services/emailService');
const jobStorage = require('../services/jobStorageService');
const exhibitService = require('../services/exhibitService');
const tocGenerator = require('../services/tocGenerator');
const aiClassificationService = require('../services/aiClassificationService');
const compressionService = require('../services/compressionService');

// Configure multer for PDF uploads (exhibit generation)
const pdfUpload = multer({
  dest: path.join(__dirname, '../../uploads'),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'), false);
    }
  }
});

// Configure multer for URL file uploads (text/csv/json with URLs)
const urlFileUpload = multer({
  dest: path.join(__dirname, '../../uploads'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.txt', '.csv', '.json'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .txt, .csv, and .json files are allowed'), false);
    }
  }
});

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
router.post('/convert', urlFileUpload.single('urlFile'), convertValidation, async (req, res) => {
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
 * Get service configuration status
 * GET /api/pdf/config-status
 * Returns which features are available
 */
router.get('/config-status', async (req, res) => {
  const compressionAvailable = await compressionService.isAvailable();
  
  res.json({
    urlConversion: true, // Always true with Puppeteer
    pdfUpload: true,
    pdfCompression: compressionAvailable,
    aiClassification: !!process.env.ANTHROPIC_API_KEY || !!process.env.OPENAI_API_KEY,
    googleDrive: !!process.env.GOOGLE_CREDENTIALS_BASE64,
    email: !!process.env.SENDGRID_API_KEY || !!process.env.EMAIL_PASSWORD,
    supabase: !!process.env.SUPABASE_URL,
    message: compressionAvailable 
      ? 'All services configured (using Puppeteer for PDF conversion, Ghostscript for compression)'
      : 'PDF compression unavailable - install Ghostscript for smaller file sizes'
  });
});

/**
 * Get job by ID (alias for /status/:jobId)
 * GET /api/pdf/jobs/:jobId
 */
router.get('/jobs/:jobId', async (req, res) => {
  try {
    const job = await jobStorage.getJob(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json(job);
  } catch (error) {
    console.error('Error getting job:', error);
    res.status(500).json({ error: 'Failed to get job' });
  }
});

/**
 * Generate exhibits from URLs (alias for /generate with URL-only workflow)
 * POST /api/pdf/generate-exhibits
 * Accepts JSON body with:
 * - urls: array of URL strings or objects with {url, label}
 * - visaType: string (optional)
 * - beneficiaryName: string (optional)
 * - caseName: string (optional)
 * - deliveryMethod: 'download' | 'email' | 'drive'
 * - recipientEmail: string (required for email/drive)
 */
router.post('/generate-exhibits', async (req, res) => {
  let tempDir = null;

  try {
    const {
      urls = [],
      visaType = '',
      beneficiaryName = '',
      caseName = '',
      numberingStyle = 'letters',
      enableToc = true,
      enableCoverPages = true,
      deliveryMethod = 'download',
      recipientEmail = ''
    } = req.body;

    // Validate URLs
    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ error: 'urls array is required' });
    }

    // Parse and validate URL list
    const validUrls = urls
      .map((item, idx) => {
        const url = typeof item === 'string' ? item : item?.url;
        const label = typeof item === 'object' ? item.label : `Document ${idx + 1}`;
        return { url, label };
      })
      .filter(item => item.url && isValidUrl(item.url));

    if (validUrls.length === 0) {
      return res.status(400).json({ error: 'No valid URLs provided' });
    }

    // Limit URLs
    if (validUrls.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 URLs per request' });
    }

    // Validate email if delivery method requires it
    if ((deliveryMethod === 'email' || deliveryMethod === 'drive') && !recipientEmail) {
      return res.status(400).json({ error: 'recipientEmail is required for email/drive delivery' });
    }

    // Create job
    const jobId = uuidv4();
    tempDir = path.join(__dirname, '../../temp', jobId);
    fs.mkdirSync(tempDir, { recursive: true });

    // Convert URLs to exhibit format
    const exhibitsData = validUrls.map((item, idx) => ({
      id: `url_${idx}`,
      type: 'url',
      url: item.url,
      label: sanitizeString(item.label),
      order: idx
    }));

    // Create job in storage
    await jobStorage.createJob({
      id: jobId,
      status: 'processing',
      progress: 0,
      totalExhibits: exhibitsData.length,
      processedExhibits: 0,
      successCount: 0,
      failedCount: 0,
      deliveryMethod,
      recipientEmail,
      caseName: caseName || `Exhibits_${new Date().toISOString().split('T')[0]}`,
      logs: [],
      createdAt: new Date().toISOString(),
    });

    // Return immediately and process in background
    res.json({
      success: true,
      jobId,
      message: `Started processing ${exhibitsData.length} URLs`,
      statusUrl: `/api/pdf/status/${jobId}`,
    });

    // Process in background
    processExhibitPackage(
      jobId,
      exhibitsData,
      [], // No uploaded files
      tempDir,
      {
        visaType,
        beneficiaryName,
        caseName,
        numberingStyle,
        enableToc,
        enableCoverPages,
        deliveryMethod,
        recipientEmail
      }
    );

  } catch (error) {
    console.error('Error starting generate-exhibits job:', error);
    if (tempDir) cleanupDir(tempDir);
    res.status(500).json({ error: 'Failed to start generation job' });
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

/**
 * Generate exhibit package (full workflow)
 * POST /api/pdf/generate
 * Accepts multipart form with:
 * - config: JSON string with settings
 * - exhibits: JSON string with exhibit metadata
 * - files: PDF files
 */
router.post('/generate', pdfUpload.array('files', 100), async (req, res) => {
  let tempDir = null;

  try {
    // Parse configuration
    const config = JSON.parse(req.body.config || '{}');
    const exhibitsData = JSON.parse(req.body.exhibits || '[]');

    const {
      visaType = '',
      numberingStyle = 'letters',
      beneficiaryName = '',
      petitionerName = '',
      caseName = '',
      enableCompression = true,
      enableToc = true,
      enableCoverPages = true,
      deliveryMethod = 'download',
      recipientEmail = ''
    } = config;

    if (exhibitsData.length === 0) {
      return res.status(400).json({ error: 'No exhibits provided' });
    }

    // Create job
    const jobId = uuidv4();
    tempDir = path.join(__dirname, '../../temp', jobId);
    fs.mkdirSync(tempDir, { recursive: true });

    // Create job in storage
    await jobStorage.createJob({
      id: jobId,
      status: 'processing',
      progress: 0,
      totalExhibits: exhibitsData.length,
      processedExhibits: 0,
      successCount: 0,
      failedCount: 0,
      deliveryMethod,
      recipientEmail,
      caseName: caseName || `Exhibit_Package_${new Date().toISOString().split('T')[0]}`,
      logs: [],
      createdAt: new Date().toISOString(),
    });

    // Return immediately and process in background
    res.json({
      success: true,
      jobId,
      message: `Started processing ${exhibitsData.length} exhibits`,
      statusUrl: `/api/pdf/status/${jobId}`,
    });

    // Process in background
    processExhibitPackage(
      jobId,
      exhibitsData,
      req.files || [],
      tempDir,
      config
    );

  } catch (error) {
    console.error('Error starting generate job:', error);
    if (tempDir) cleanupDir(tempDir);
    res.status(500).json({ error: 'Failed to start generation job' });
  }
});

/**
 * Process exhibit package in background
 */
async function processExhibitPackage(jobId, exhibitsData, uploadedFiles, tempDir, config) {
  try {
    const {
      numberingStyle = 'letters',
      beneficiaryName = '',
      caseName = '',
      enableToc = true,
      enableCoverPages = true,
      deliveryMethod = 'download',
      recipientEmail = ''
    } = config;

    await jobStorage.addLog(jobId, 'Starting exhibit package generation...');
    await jobStorage.updateJob(jobId, { progress: 5 });

    // Step 1: Collect all PDFs (from uploads and URL conversions)
    await jobStorage.addLog(jobId, 'Collecting documents...');
    const collectedPdfs = [];

    // Map uploaded files by their ID
    const uploadedFilesMap = new Map();
    for (const file of uploadedFiles) {
      // Extract ID from filename (format: id.pdf)
      const id = path.basename(file.originalname, '.pdf');
      uploadedFilesMap.set(id, file.path);
    }

    // Process each exhibit
    let processedCount = 0;
    for (const exhibit of exhibitsData) {
      try {
        let pdfPath = null;

        if (exhibit.type === 'pdf') {
          // Find uploaded file
          const filePath = uploadedFilesMap.get(exhibit.id);
          if (filePath && fs.existsSync(filePath)) {
            pdfPath = filePath;
          }
        } else if (exhibit.type === 'url' && exhibit.url) {
          // Convert URL to PDF using Puppeteer
          await jobStorage.addLog(jobId, `Converting URL: ${exhibit.label || exhibit.url.substring(0, 50)}...`);
          const fileName = `url_${exhibit.id}.pdf`;
          const result = await pdfService.convertUrlToPdfWithRetry(exhibit.url, fileName);

          if (result.success && result.pdfBuffer) {
            // Save the PDF buffer to temp directory
            const localPath = path.join(tempDir, fileName);
            fs.writeFileSync(localPath, result.pdfBuffer);
            pdfPath = localPath;
            await jobStorage.addLog(jobId, `Converted: ${exhibit.label || fileName}`);
          } else {
            await jobStorage.addLog(jobId, `Failed to convert URL: ${result.error || 'Unknown error'}`);
          }
        }

        if (pdfPath) {
          collectedPdfs.push({
            id: exhibit.id,
            path: pdfPath,
            label: exhibit.label || 'Untitled',
            order: exhibit.order || processedCount,
            classification: exhibit.classification || null
          });
          processedCount++;
        }
      } catch (err) {
        await jobStorage.addLog(jobId, `Error processing ${exhibit.label}: ${err.message}`);
      }

      // Update progress
      const progress = Math.round(10 + (processedCount / exhibitsData.length) * 30);
      await jobStorage.updateJob(jobId, { progress, processedExhibits: processedCount });
    }

    if (collectedPdfs.length === 0) {
      throw new Error('No documents could be processed');
    }

    await jobStorage.addLog(jobId, `Collected ${collectedPdfs.length} documents`);
    await jobStorage.updateJob(jobId, { progress: 40, successCount: collectedPdfs.length });

    // Sort by order
    collectedPdfs.sort((a, b) => a.order - b.order);

    // Step 2: Add cover pages and exhibit numbers
    let processedPdfs = [];
    if (enableCoverPages) {
      await jobStorage.addLog(jobId, 'Adding exhibit cover pages...');
      processedPdfs = await exhibitService.processExhibits(collectedPdfs, numberingStyle, tempDir, { caseName });
      await jobStorage.updateJob(jobId, { progress: 60 });
    } else {
      processedPdfs = collectedPdfs.map((pdf, idx) => ({
        ...pdf,
        exhibitNumber: getExhibitNumber(idx, numberingStyle)
      }));
    }

    // Step 3: Generate Table of Contents
    let tocPath = null;
    if (enableToc) {
      await jobStorage.addLog(jobId, 'Generating Table of Contents...');
      const tocExhibits = processedPdfs.map((pdf, idx) => ({
        exhibitNumber: pdf.exhibitNumber || getExhibitNumber(idx, numberingStyle),
        label: pdf.label,
        fileName: path.basename(pdf.path)
      }));

      const tocBuffer = await tocGenerator.generateTocPdf(tocExhibits, {
        title: 'TABLE OF CONTENTS',
        caseName: caseName || beneficiaryName || 'Exhibit Package'
      });

      tocPath = path.join(tempDir, 'toc.pdf');
      fs.writeFileSync(tocPath, tocBuffer);
      await jobStorage.updateJob(jobId, { progress: 70 });
    }

    // Step 4: Merge all PDFs
    await jobStorage.addLog(jobId, 'Merging into final package...');
    const outputPath = path.join(tempDir, `Exhibit_Package_${Date.now()}.pdf`);

    const pdfPaths = [];
    if (tocPath) pdfPaths.push(tocPath);
    pdfPaths.push(...processedPdfs.map(p => p.processedPath || p.path));

    await exhibitService.combineExhibits(pdfPaths, outputPath);
    await jobStorage.updateJob(jobId, { progress: 80 });

    // Get initial file stats
    let stats = fs.statSync(outputPath);
    const originalSize = stats.size;
    const totalPages = processedPdfs.reduce((sum, p) => sum + (p.pageCount || 1), 0);

    // Step 5: Compress PDF if needed (especially for email)
    const enableCompression = config.enableCompression !== false; // Default to true
    const compressionPreset = config.compressionPreset || 'ebook';
    let compressionResult = null;

    if (enableCompression && await compressionService.isAvailable()) {
      await jobStorage.addLog(jobId, 'Compressing PDF...');
      await jobStorage.updateJob(jobId, { progress: 85 });

      // For email, try to get under 20MB; otherwise just compress with preset
      if (deliveryMethod === 'email' && originalSize > compressionService.MAX_EMAIL_SIZE) {
        compressionResult = await compressionService.compressToTargetSize(
          outputPath, 
          null, 
          compressionService.MAX_EMAIL_SIZE
        );
      } else {
        compressionResult = await compressionService.compressPdf(outputPath, null, {
          preset: compressionPreset,
        });
      }

      if (compressionResult.success) {
        stats = fs.statSync(outputPath); // Get updated stats
        await jobStorage.addLog(jobId, 
          `Compressed: ${compressionService.formatBytes(originalSize)} → ${compressionService.formatBytes(stats.size)} (${compressionResult.reduction} reduction)`
        );
      } else {
        await jobStorage.addLog(jobId, `Compression skipped: ${compressionResult.error || 'Unknown error'}`);
      }
    } else if (enableCompression) {
      await jobStorage.addLog(jobId, 'Compression skipped: Ghostscript not installed');
    }

    await jobStorage.updateJob(jobId, { progress: 90 });

    // Step 6: Deliver
    await jobStorage.addLog(jobId, 'Preparing delivery...');

    if (deliveryMethod === 'download') {
      // For download, save the file path
      await jobStorage.updateJob(jobId, {
        status: 'completed',
        progress: 100,
        downloadUrl: `/api/pdf/download/${jobId}`,
        outputPath: outputPath,
        packageSize: stats.size,
        originalSize: originalSize,
        compressionApplied: compressionResult?.success || false,
        totalPages: totalPages,
        completedAt: new Date().toISOString()
      });
      await jobStorage.addLog(jobId, 'Package ready for download');

    } else if (deliveryMethod === 'drive' && recipientEmail) {
      await jobStorage.addLog(jobId, 'Uploading to Google Drive...');
      const driveResult = await googleDriveService.uploadFile(outputPath, caseName || 'Exhibit_Package');

      if (driveResult.success) {
        await googleDriveService.shareFile(driveResult.fileId, recipientEmail);
        await jobStorage.updateJob(jobId, {
          status: 'completed',
          progress: 100,
          driveLink: driveResult.webViewLink,
          packageSize: stats.size,
          originalSize: originalSize,
          compressionApplied: compressionResult?.success || false,
          totalPages: totalPages,
          completedAt: new Date().toISOString()
        });
        await jobStorage.addLog(jobId, `Shared to ${recipientEmail}`);
      } else {
        throw new Error(driveResult.error || 'Failed to upload to Google Drive');
      }

    } else if (deliveryMethod === 'email' && recipientEmail) {
      const MAX_EMAIL_ATTACHMENT_SIZE = 15 * 1024 * 1024; // 15MB threshold for Supabase upload
      
      // Check if file is too large for email attachment
      if (stats.size > MAX_EMAIL_ATTACHMENT_SIZE) {
        await jobStorage.addLog(jobId, `File size (${compressionService.formatBytes(stats.size)}) exceeds email attachment limit. Uploading to cloud storage...`);
        
        // Try Supabase Storage first
        const supabaseService = require('../services/supabaseService');
        if (supabaseService.isStorageAvailable()) {
          await jobStorage.addLog(jobId, 'Uploading to Supabase Storage...');
          
          const fileName = `Exhibit_Package_${jobId.substring(0, 8)}.pdf`;
          const uploadResult = await supabaseService.uploadPdfToStorage(outputPath, fileName, jobId);
          
          if (uploadResult.success) {
            await jobStorage.addLog(jobId, 'Upload complete. Sending download link via email...');
            
            // Send email with download link
            const emailResult = await emailService.sendEmailWithDownloadLink(
              recipientEmail,
              `Exhibit Package Ready: ${caseName || 'Your Documents'}`,
              {
                downloadUrl: uploadResult.signedUrl,
                fileName: fileName,
                fileSize: stats.size,
                originalSize: originalSize,
                expiresAt: uploadResult.expiresAt,
                caseName: caseName || 'Your Documents',
                totalExhibits: collectedPdfs.length,
                totalPages: totalPages,
                compressionApplied: compressionResult?.success || false,
              }
            );
            
            if (emailResult.success) {
              await jobStorage.updateJob(jobId, {
                status: 'completed',
                progress: 100,
                packageSize: stats.size,
                originalSize: originalSize,
                compressionApplied: compressionResult?.success || false,
                totalPages: totalPages,
                downloadUrl: uploadResult.signedUrl,
                storagePath: uploadResult.path,
                storageExpiresAt: uploadResult.expiresAt,
                note: 'Large file uploaded to cloud storage. Download link sent via email.',
                completedAt: new Date().toISOString()
              });
              await jobStorage.addLog(jobId, `Download link emailed to ${recipientEmail} (expires: ${new Date(uploadResult.expiresAt).toLocaleDateString()})`);
              return;
            } else {
              await jobStorage.addLog(jobId, `Email failed: ${emailResult.error}. Trying Google Drive...`);
            }
          } else {
            await jobStorage.addLog(jobId, `Supabase upload failed: ${uploadResult.error}. Trying Google Drive...`);
          }
        }
        
        // Fallback to Google Drive
        if (process.env.GOOGLE_CREDENTIALS_BASE64) {
          await jobStorage.addLog(jobId, 'Uploading to Google Drive...');
          const driveResult = await googleDriveService.uploadFile(outputPath, caseName || 'Exhibit_Package');
          if (driveResult.success) {
            await googleDriveService.shareFile(driveResult.fileId, recipientEmail);
            await jobStorage.updateJob(jobId, {
              status: 'completed',
              progress: 100,
              driveLink: driveResult.webViewLink,
              packageSize: stats.size,
              originalSize: originalSize,
              totalPages: totalPages,
              note: 'File too large for email - uploaded to Google Drive instead',
              completedAt: new Date().toISOString()
            });
            await jobStorage.addLog(jobId, `File uploaded to Google Drive and shared with ${recipientEmail}`);
            return;
          }
        }
        
        throw new Error(`File size (${compressionService.formatBytes(stats.size)}) exceeds email attachment limit (15MB). Please configure Supabase Storage or Google Drive for large file delivery.`);
      }

      // File is small enough for email attachment
      await jobStorage.addLog(jobId, 'Sending email with attachment...');
      const emailResult = await emailService.sendEmailWithZip(
        recipientEmail,
        `Exhibit Package: ${caseName || 'Your Documents'}`,
        `<p>Please find your exhibit package attached.</p>
         <p><small>Package size: ${compressionService.formatBytes(stats.size)}${compressionResult?.success ? ` (compressed from ${compressionService.formatBytes(originalSize)})` : ''}</small></p>`,
        outputPath,
        'Exhibit_Package.pdf'
      );

      if (emailResult.success) {
        await jobStorage.updateJob(jobId, {
          status: 'completed',
          progress: 100,
          packageSize: stats.size,
          originalSize: originalSize,
          compressionApplied: compressionResult?.success || false,
          totalPages: totalPages,
          completedAt: new Date().toISOString()
        });
        await jobStorage.addLog(jobId, `Email with attachment sent to ${recipientEmail}`);
      } else {
        throw new Error(emailResult.error || 'Failed to send email');
      }
    }

  } catch (error) {
    console.error(`Generate job ${jobId} failed:`, error);
    await jobStorage.updateJob(jobId, {
      status: 'failed',
      error: error.message
    });
    await jobStorage.addLog(jobId, `Error: ${error.message}`);
  }
}

/**
 * Get exhibit number based on style
 */
function getExhibitNumber(index, style) {
  const num = index + 1;
  switch (style) {
    case 'numbers':
      return String(num);
    case 'roman':
      return toRoman(num);
    case 'letters':
    default:
      return toLetters(num);
  }
}

function toLetters(num) {
  let result = '';
  while (num > 0) {
    num--;
    result = String.fromCharCode(65 + (num % 26)) + result;
    num = Math.floor(num / 26);
  }
  return result;
}

function toRoman(num) {
  const romanNumerals = [
    ['M', 1000], ['CM', 900], ['D', 500], ['CD', 400],
    ['C', 100], ['XC', 90], ['L', 50], ['XL', 40],
    ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1]
  ];
  let result = '';
  for (const [letter, value] of romanNumerals) {
    while (num >= value) {
      result += letter;
      num -= value;
    }
  }
  return result;
}

/**
 * Download generated package
 * GET /api/pdf/download/:jobId
 */
router.get('/download/:jobId', async (req, res) => {
  try {
    const job = await jobStorage.getJob(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (job.status !== 'completed') {
      return res.status(400).json({ error: 'Package not ready for download' });
    }

    // Check if file is in Supabase Storage
    if (job.storagePath) {
      const supabaseService = require('../services/supabaseService');
      
      // Check if the signed URL has expired
      if (job.storageExpiresAt && new Date(job.storageExpiresAt) < new Date()) {
        // Generate a new signed URL
        const newUrlResult = await supabaseService.getSignedUrl(job.storagePath);
        if (newUrlResult.success) {
          // Update job with new URL
          await jobStorage.updateJob(req.params.jobId, {
            downloadUrl: newUrlResult.signedUrl,
            storageExpiresAt: newUrlResult.expiresAt,
          });
          return res.redirect(newUrlResult.signedUrl);
        } else {
          return res.status(410).json({ 
            error: 'Download link expired and could not be refreshed',
            suggestion: 'Please regenerate the package'
          });
        }
      }
      
      // Redirect to Supabase signed URL
      if (job.downloadUrl) {
        return res.redirect(job.downloadUrl);
      }
    }

    // Fallback to local file download
    if (!job.outputPath) {
      return res.status(400).json({ error: 'Package not ready for download' });
    }

    if (!fs.existsSync(job.outputPath)) {
      return res.status(404).json({ error: 'Package file not found. It may have been cleaned up.' });
    }

    res.download(job.outputPath, `Exhibit_Package_${req.params.jobId.substring(0, 8)}.pdf`);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Failed to download package' });
  }
});

/**
 * Refresh download link for a job (if stored in Supabase)
 * POST /api/pdf/refresh-link/:jobId
 */
router.post('/refresh-link/:jobId', async (req, res) => {
  try {
    const job = await jobStorage.getJob(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (!job.storagePath) {
      return res.status(400).json({ 
        error: 'This job does not have a cloud storage file',
        hasLocalFile: job.outputPath ? fs.existsSync(job.outputPath) : false
      });
    }

    const supabaseService = require('../services/supabaseService');
    const newUrlResult = await supabaseService.getSignedUrl(job.storagePath);

    if (!newUrlResult.success) {
      return res.status(500).json({ error: newUrlResult.error || 'Failed to refresh link' });
    }

    // Update job with new URL
    await jobStorage.updateJob(req.params.jobId, {
      downloadUrl: newUrlResult.signedUrl,
      storageExpiresAt: newUrlResult.expiresAt,
    });

    res.json({
      success: true,
      downloadUrl: newUrlResult.signedUrl,
      expiresAt: newUrlResult.expiresAt,
      expiresIn: `${Math.round(supabaseService.SIGNED_URL_EXPIRY / 86400)} days`,
    });

  } catch (error) {
    console.error('Refresh link error:', error);
    res.status(500).json({ error: 'Failed to refresh download link' });
  }
});

// ============================================
// AI Classification Endpoints
// ============================================

/**
 * Get available visa types and their criteria
 * GET /api/pdf/visa-types
 */
router.get('/visa-types', (req, res) => {
  const visaTypes = aiClassificationService.getAvailableVisaTypes();
  res.json({ visaTypes });
});

/**
 * Get criteria for a specific visa type
 * GET /api/pdf/visa-types/:type/criteria
 */
router.get('/visa-types/:type/criteria', (req, res) => {
  const criteria = aiClassificationService.getCriteriaForVisaType(req.params.type);
  if (!criteria) {
    return res.status(404).json({ error: 'Visa type not found' });
  }
  res.json(criteria);
});

/**
 * Classify uploaded PDFs
 * POST /api/pdf/classify
 */
router.post('/classify', pdfUpload.array('files', 50), async (req, res) => {
  try {
    const { visaType } = req.body;

    if (!visaType) {
      return res.status(400).json({ error: 'visaType is required' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // Parse labels if provided
    let labels = {};
    if (req.body.labels) {
      try {
        labels = JSON.parse(req.body.labels);
      } catch (e) {
        // Ignore parse error
      }
    }

    // Prepare documents for classification
    const documents = req.files.map((file, idx) => ({
      id: file.filename,
      path: file.path,
      label: labels[file.originalname] || file.originalname.replace(/\.pdf$/i, ''),
    }));

    // Classify documents
    const results = await aiClassificationService.classifyDocuments(documents, visaType);

    // Analyze for missing criteria
    const analysis = await aiClassificationService.analyzeMissingCriteria(results, visaType);

    // Clean up uploaded files
    for (const file of req.files) {
      try {
        fs.unlinkSync(file.path);
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    res.json({
      success: true,
      classifications: results,
      analysis,
    });

  } catch (error) {
    console.error('Classification error:', error);
    res.status(500).json({ error: 'Classification failed: ' + error.message });
  }
});

/**
 * Suggest a name for a PDF based on its content
 * POST /api/pdf/suggest-name
 */
router.post('/suggest-name', pdfUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const suggestedName = await aiClassificationService.suggestDocumentName(req.file.path);

    // Clean up
    try {
      fs.unlinkSync(req.file.path);
    } catch (e) {
      // Ignore
    }

    if (suggestedName) {
      res.json({ success: true, suggestedName });
    } else {
      res.json({ success: false, error: 'Could not suggest name' });
    }

  } catch (error) {
    console.error('Suggest name error:', error);
    res.status(500).json({ error: 'Failed to suggest name' });
  }
});

/**
 * Get document types that support a specific criterion
 * GET /api/pdf/visa-types/:type/criteria/:criterionId/documents
 */
router.get('/visa-types/:type/criteria/:criterionId/documents', (req, res) => {
  const { type, criterionId } = req.params;
  const documentTypes = aiClassificationService.getDocumentTypesForCriterion(type, criterionId);

  if (!documentTypes) {
    return res.status(404).json({ error: 'Visa type or criterion not found' });
  }

  res.json(documentTypes);
});

/**
 * Get all document type mappings for labeling assistance
 * GET /api/pdf/document-types
 */
router.get('/document-types', (req, res) => {
  const documentTypeMap = aiClassificationService.getDocumentTypeMap();
  res.json({ documentTypes: documentTypeMap });
});

/**
 * Suggest optimal exhibit ordering based on classifications
 * POST /api/pdf/suggest-order
 */
router.post('/suggest-order', async (req, res) => {
  try {
    const { classifiedDocuments, visaType } = req.body;

    if (!visaType) {
      return res.status(400).json({ error: 'visaType is required' });
    }

    if (!classifiedDocuments || !Array.isArray(classifiedDocuments)) {
      return res.status(400).json({ error: 'classifiedDocuments array is required' });
    }

    const orderedDocuments = aiClassificationService.suggestExhibitOrder(classifiedDocuments, visaType);

    res.json({
      success: true,
      orderedDocuments,
    });

  } catch (error) {
    console.error('Suggest order error:', error);
    res.status(500).json({ error: 'Failed to suggest order: ' + error.message });
  }
});

/**
 * Generate comprehensive exhibit summary report
 * POST /api/pdf/exhibit-summary
 */
router.post('/exhibit-summary', async (req, res) => {
  try {
    const { classifiedDocuments, visaType } = req.body;

    if (!visaType) {
      return res.status(400).json({ error: 'visaType is required' });
    }

    if (!classifiedDocuments || !Array.isArray(classifiedDocuments)) {
      return res.status(400).json({ error: 'classifiedDocuments array is required' });
    }

    const summary = aiClassificationService.generateExhibitSummary(classifiedDocuments, visaType);

    if (!summary) {
      return res.status(400).json({ error: 'Could not generate summary for visa type' });
    }

    res.json({
      success: true,
      summary,
    });

  } catch (error) {
    console.error('Exhibit summary error:', error);
    res.status(500).json({ error: 'Failed to generate summary: ' + error.message });
  }
});

/**
 * Get eligibility scoring thresholds
 * GET /api/pdf/eligibility-scores
 */
router.get('/eligibility-scores', (req, res) => {
  res.json({
    scores: aiClassificationService.ELIGIBILITY_SCORES,
    explanation: {
      'O-1_READY': '85%+ score indicates candidate is ready to file O-1 within 30 days',
      'O-1_DEVELOPMENT': '60-84% score indicates candidate needs evidence building (6-12 months)',
      'O-1_NOT_VIABLE': 'Below 60% may require extended development or alternative visa paths'
    }
  });
});

/**
 * Classify and organize exhibits in one step
 * POST /api/pdf/classify-and-organize
 */
router.post('/classify-and-organize', pdfUpload.array('files', 50), async (req, res) => {
  try {
    const { visaType } = req.body;

    if (!visaType) {
      return res.status(400).json({ error: 'visaType is required' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    // Parse labels if provided
    let labels = {};
    if (req.body.labels) {
      try {
        labels = JSON.parse(req.body.labels);
      } catch (e) {
        // Ignore parse error
      }
    }

    // Prepare documents for classification
    const documents = req.files.map((file, idx) => ({
      id: file.filename,
      path: file.path,
      label: labels[file.originalname] || file.originalname.replace(/\.pdf$/i, ''),
      originalFilename: file.originalname,
    }));

    // Classify documents
    const classifications = await aiClassificationService.classifyDocuments(documents, visaType);

    // Suggest optimal ordering
    const orderedDocuments = aiClassificationService.suggestExhibitOrder(classifications, visaType);

    // Generate comprehensive summary
    const summary = aiClassificationService.generateExhibitSummary(classifications, visaType);

    // Analyze for missing criteria
    const analysis = await aiClassificationService.analyzeMissingCriteria(classifications, visaType);

    // Clean up uploaded files
    for (const file of req.files) {
      try {
        fs.unlinkSync(file.path);
      } catch (e) {
        // Ignore cleanup errors
      }
    }

    res.json({
      success: true,
      classifications,
      orderedDocuments,
      summary,
      analysis,
    });

  } catch (error) {
    console.error('Classify and organize error:', error);
    res.status(500).json({ error: 'Classification failed: ' + error.message });
  }
});

// ============================================
// Compression Endpoints
// ============================================

/**
 * Get compression presets and availability
 * GET /api/pdf/compression/presets
 */
router.get('/compression/presets', async (req, res) => {
  const available = await compressionService.isAvailable();
  
  res.json({
    available,
    presets: compressionService.getPresets(),
    maxEmailSize: compressionService.MAX_EMAIL_SIZE,
    maxEmailSizeFormatted: compressionService.formatBytes(compressionService.MAX_EMAIL_SIZE),
    installInstructions: available ? null : {
      ubuntu: 'sudo apt-get install ghostscript',
      macos: 'brew install ghostscript',
      windows: 'Download from https://ghostscript.com/releases/gsdnld.html'
    }
  });
});

/**
 * Compress a single PDF file
 * POST /api/pdf/compress
 */
router.post('/compress', pdfUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const available = await compressionService.isAvailable();
    if (!available) {
      fs.unlinkSync(req.file.path);
      return res.status(503).json({ 
        error: 'Compression service unavailable. Ghostscript is not installed.',
        installInstructions: {
          ubuntu: 'sudo apt-get install ghostscript',
          macos: 'brew install ghostscript',
          windows: 'Download from https://ghostscript.com/releases/gsdnld.html'
        }
      });
    }

    const { preset = 'ebook', targetSize } = req.body;
    const originalSize = fs.statSync(req.file.path).size;

    let result;
    if (targetSize) {
      result = await compressionService.compressToTargetSize(
        req.file.path,
        null,
        parseInt(targetSize)
      );
    } else {
      result = await compressionService.compressPdf(req.file.path, null, { preset });
    }

    if (result.success) {
      // Send compressed file
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="compressed_${req.file.originalname}"`);
      res.setHeader('X-Original-Size', originalSize);
      res.setHeader('X-Compressed-Size', result.compressedSize);
      res.setHeader('X-Compression-Ratio', result.reduction);
      
      const fileStream = fs.createReadStream(req.file.path);
      fileStream.pipe(res);
      
      fileStream.on('end', () => {
        // Clean up
        try {
          fs.unlinkSync(req.file.path);
        } catch (e) {
          // Ignore
        }
      });
    } else {
      fs.unlinkSync(req.file.path);
      res.status(500).json({ error: result.error || 'Compression failed' });
    }

  } catch (error) {
    console.error('Compression error:', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Compression failed: ' + error.message });
  }
});

/**
 * Analyze PDF for compression potential
 * POST /api/pdf/compression/analyze
 */
router.post('/compression/analyze', pdfUpload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const available = await compressionService.isAvailable();
    if (!available) {
      const size = fs.statSync(req.file.path).size;
      fs.unlinkSync(req.file.path);
      return res.json({
        available: false,
        originalSize: size,
        originalSizeFormatted: compressionService.formatBytes(size),
        message: 'Ghostscript not installed - cannot analyze compression potential'
      });
    }

    const analysis = await compressionService.analyzeCompression(req.file.path);
    
    // Clean up
    fs.unlinkSync(req.file.path);

    res.json({
      available: true,
      ...analysis
    });

  } catch (error) {
    console.error('Analysis error:', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Analysis failed: ' + error.message });
  }
});

module.exports = router;