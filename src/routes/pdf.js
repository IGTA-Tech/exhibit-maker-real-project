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
          // Convert URL to PDF using api2pdf
          await jobStorage.addLog(jobId, `Converting URL: ${exhibit.label || exhibit.url.substring(0, 50)}...`);
          const fileName = `url_${exhibit.id}.pdf`;
          const result = await pdfService.convertUrlToPdfWithRetry(exhibit.url, fileName);

          if (result.success && result.fileUrl) {
            // Download the converted PDF to temp directory
            const localPath = path.join(tempDir, fileName);
            try {
              await pdfService.downloadPdfWithRetry(result.fileUrl, localPath);
              pdfPath = localPath;
              await jobStorage.addLog(jobId, `Converted: ${exhibit.label || fileName}`);
            } catch (downloadErr) {
              await jobStorage.addLog(jobId, `Failed to download converted PDF: ${downloadErr.message}`);
            }
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
    await jobStorage.updateJob(jobId, { progress: 85 });

    // Get final file stats
    const stats = fs.statSync(outputPath);
    const totalPages = processedPdfs.reduce((sum, p) => sum + (p.pageCount || 1), 0);

    // Step 5: Deliver
    await jobStorage.addLog(jobId, 'Preparing delivery...');

    if (deliveryMethod === 'download') {
      // For download, save the file path
      await jobStorage.updateJob(jobId, {
        status: 'completed',
        progress: 100,
        downloadUrl: `/api/pdf/download/${jobId}`,
        outputPath: outputPath,
        packageSize: stats.size,
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
          totalPages: totalPages,
          completedAt: new Date().toISOString()
        });
        await jobStorage.addLog(jobId, `Shared to ${recipientEmail}`);
      } else {
        throw new Error(driveResult.error || 'Failed to upload to Google Drive');
      }

    } else if (deliveryMethod === 'email' && recipientEmail) {
      await jobStorage.addLog(jobId, 'Sending email...');
      const emailResult = await emailService.sendEmailWithZip(
        recipientEmail,
        `Exhibit Package: ${caseName || 'Your Documents'}`,
        '<p>Please find your exhibit package attached.</p>',
        outputPath,
        'Exhibit_Package.pdf'
      );

      if (emailResult.success) {
        await jobStorage.updateJob(jobId, {
          status: 'completed',
          progress: 100,
          packageSize: stats.size,
          totalPages: totalPages,
          completedAt: new Date().toISOString()
        });
        await jobStorage.addLog(jobId, `Email sent to ${recipientEmail}`);
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

    if (job.status !== 'completed' || !job.outputPath) {
      return res.status(400).json({ error: 'Package not ready for download' });
    }

    if (!fs.existsSync(job.outputPath)) {
      return res.status(404).json({ error: 'Package file not found' });
    }

    res.download(job.outputPath, `Exhibit_Package_${req.params.jobId.substring(0, 8)}.pdf`);
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Failed to download package' });
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

module.exports = router;
