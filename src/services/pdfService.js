/**
 * PDF Service - Using Puppeteer for URL to PDF conversion
 * Self-hosted solution - no external API required
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Browser instance (reused for performance)
let browserInstance = null;
let browserLaunchPromise = null;

/**
 * Get or create browser instance
 */
async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  // Prevent multiple simultaneous launches
  if (browserLaunchPromise) {
    return browserLaunchPromise;
  }

  browserLaunchPromise = puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--metrics-recording-only',
      '--mute-audio',
      '--safebrowsing-disable-auto-update',
    ],
  });

  browserInstance = await browserLaunchPromise;
  browserLaunchPromise = null;

  // Handle browser disconnect
  browserInstance.on('disconnected', () => {
    browserInstance = null;
  });

  return browserInstance;
}

/**
 * Close browser instance (call on shutdown)
 */
async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * Check if PDF conversion is available (always true with Puppeteer)
 */
function isApiConfigured() {
  return true; // Puppeteer doesn't need external API
}

// Common errors that indicate retry might help
const RETRYABLE_ERRORS = [
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'timeout',
  'Navigation timeout',
  'net::ERR_',
  'Protocol error',
];

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if error is retryable
 */
function isRetryableError(error) {
  const errorStr = String(error).toLowerCase();
  return RETRYABLE_ERRORS.some(e => errorStr.toLowerCase().includes(e.toLowerCase()));
}

/**
 * Convert a single URL to PDF using Puppeteer
 */
async function convertUrlToPdf(url, fileName, options = {}) {
  let page = null;
  
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    // Set viewport
    await page.setViewport({
      width: parseInt(options.width) || 1920,
      height: parseInt(options.height) || 1080,
    });

    // Set user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Set timeout
    const timeout = options.timeout || 60000;
    page.setDefaultNavigationTimeout(timeout);
    page.setDefaultTimeout(timeout);

    // Navigate to URL
    await page.goto(url, {
      waitUntil: ['load', 'domcontentloaded', 'networkidle2'],
      timeout: timeout,
    });

    // Optional delay to allow dynamic content to load
    const delay = options.delay || 2000;
    if (delay > 0) {
      await sleep(delay);
    }

    // Generate PDF
    const pdfBuffer = await page.pdf({
      format: options.format || 'A4',
      printBackground: true,
      margin: {
        top: options.marginTop || '10mm',
        right: options.marginRight || '10mm',
        bottom: options.marginBottom || '10mm',
        left: options.marginLeft || '10mm',
      },
      displayHeaderFooter: options.displayHeaderFooter || false,
      preferCSSPageSize: true,
    });

    return {
      success: true,
      pdfBuffer: pdfBuffer,
      fileName: fileName,
    };

  } catch (error) {
    console.error(`Error converting ${url}:`, error.message);
    return {
      success: false,
      error: error.message,
      fileName: fileName,
      retryable: isRetryableError(error.message),
    };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        // Ignore close errors
      }
    }
  }
}

/**
 * Convert URL with retry logic
 */
async function convertUrlToPdfWithRetry(url, fileName, options = {}, maxRetries = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const result = await convertUrlToPdf(url, fileName, options);

    if (result.success) {
      return result;
    }

    lastError = result.error;

    // Don't retry if not a retryable error
    if (!result.retryable) {
      return result;
    }

    // Don't sleep after the last attempt
    if (attempt < maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      console.log(`Retry ${attempt}/${maxRetries} for ${fileName} after ${delay}ms`);
      await sleep(delay);
    }
  }

  return { success: false, error: lastError || 'Max retries exceeded', fileName };
}

/**
 * Download PDF from URL to local file (kept for compatibility, but now we generate directly)
 */
async function downloadPdf(pdfUrl, localPath) {
  // This function is kept for API compatibility but is not needed with Puppeteer
  // since we generate the PDF buffer directly
  throw new Error('downloadPdf is deprecated - use convertUrlToPdf which returns buffer directly');
}

/**
 * Download PDF with retry logic (kept for compatibility)
 */
async function downloadPdfWithRetry(pdfUrl, localPath, maxRetries = 3) {
  throw new Error('downloadPdfWithRetry is deprecated - use convertUrlToPdfWithRetry which returns buffer directly');
}

/**
 * Check if PDF is encrypted/password protected
 */
async function isPdfEncrypted(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const content = buffer.toString('latin1');

    // Check for encryption dictionary
    if (content.includes('/Encrypt')) {
      return true;
    }

    return false;
  } catch (error) {
    console.error('Error checking PDF encryption:', error.message);
    return false;
  }
}

/**
 * Process multiple URLs with rate limiting
 */
async function processUrls(urls, outputDir, onProgress) {
  const results = {
    success: [],
    failed: [],
    skipped: [],
    total: urls.length
  };

  const batchSize = 3; // Lower batch size for Puppeteer (memory considerations)
  const delayBetweenBatches = 1000;

  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    const batchNumber = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(urls.length / batchSize);

    if (onProgress) {
      onProgress({
        type: 'batch',
        current: batchNumber,
        total: totalBatches,
        processed: i,
        totalUrls: urls.length
      });
    }

    // Process batch sequentially to avoid memory issues
    for (let idx = 0; idx < batch.length; idx++) {
      const item = batch[idx];
      const index = i + idx + 1;
      const fileName = item.fileName || `PDF_${String(index).padStart(3, '0')}.pdf`;

      try {
        // Convert URL to PDF with retry
        const result = await convertUrlToPdfWithRetry(item.url, fileName);

        if (result.success && result.pdfBuffer) {
          // Save the PDF to local file
          const localPath = path.join(outputDir, fileName);
          fs.writeFileSync(localPath, result.pdfBuffer);

          // Check if PDF is encrypted
          if (await isPdfEncrypted(localPath)) {
            results.skipped.push({
              index,
              url: item.url,
              fileName,
              localPath,
              reason: 'PDF is encrypted/password protected',
              label: item.label || ''
            });

            if (onProgress) {
              onProgress({
                type: 'skipped',
                index,
                fileName,
                url: item.url,
                reason: 'Encrypted PDF'
              });
            }
          } else {
            results.success.push({
              index,
              url: item.url,
              fileName,
              localPath,
              label: item.label || ''
            });

            if (onProgress) {
              onProgress({ type: 'success', index, fileName, url: item.url });
            }
          }
        } else {
          results.failed.push({
            index,
            url: item.url,
            fileName,
            error: result.error,
            label: item.label || ''
          });

          if (onProgress) {
            onProgress({ type: 'failed', index, fileName, url: item.url, error: result.error });
          }
        }
      } catch (error) {
        results.failed.push({
          index,
          url: item.url,
          fileName,
          error: error.message,
          label: item.label || ''
        });

        if (onProgress) {
          onProgress({ type: 'failed', index, fileName, url: item.url, error: error.message });
        }
      }
    }

    // Delay between batches (except for last batch)
    if (i + batchSize < urls.length) {
      await sleep(delayBetweenBatches);
    }
  }

  return results;
}

/**
 * Parse URLs from various input formats
 */
function parseUrls(input, format = 'text') {
  const urls = [];

  if (format === 'json') {
    try {
      const data = JSON.parse(input);
      if (Array.isArray(data)) {
        data.forEach((item, idx) => {
          if (typeof item === 'string') {
            if (isValidUrl(item)) {
              urls.push({ url: item, fileName: `PDF_${String(idx + 1).padStart(3, '0')}.pdf` });
            }
          } else if (item.url && isValidUrl(item.url)) {
            urls.push({
              url: item.url,
              fileName: sanitizeFileName(item.fileName || item.name) || `PDF_${String(idx + 1).padStart(3, '0')}.pdf`,
              label: item.label || item.description || ''
            });
          }
        });
      }
    } catch (e) {
      throw new Error('Invalid JSON format');
    }
  } else {
    // Text or CSV format - one URL per line
    const lines = input.split(/[\r\n]+/).filter(line => line.trim());

    lines.forEach((line, idx) => {
      // Handle CSV with comma separation (url, label, filename)
      const parts = line.split(',').map(p => p.trim());
      const url = parts[0];

      if (url && isValidUrl(url)) {
        urls.push({
          url: url,
          label: parts[1] || '',
          fileName: sanitizeFileName(parts[2]) || `PDF_${String(idx + 1).padStart(3, '0')}.pdf`
        });
      }
    });
  }

  return urls;
}

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
 * Sanitize filename to prevent path traversal and invalid characters
 */
function sanitizeFileName(fileName) {
  if (!fileName) return null;

  // Remove path traversal attempts
  let sanitized = fileName.replace(/\.\./g, '').replace(/[/\\]/g, '');

  // Remove invalid characters
  sanitized = sanitized.replace(/[<>:"|?*]/g, '_');

  // Limit length
  if (sanitized.length > 200) {
    const ext = path.extname(sanitized);
    sanitized = sanitized.substring(0, 196) + ext;
  }

  // Ensure .pdf extension
  if (!sanitized.toLowerCase().endsWith('.pdf')) {
    sanitized += '.pdf';
  }

  return sanitized;
}

// Cleanup on process exit
process.on('exit', () => {
  if (browserInstance) {
    browserInstance.close().catch(() => {});
  }
});

process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeBrowser();
  process.exit(0);
});

module.exports = {
  convertUrlToPdf,
  convertUrlToPdfWithRetry,
  downloadPdf,
  downloadPdfWithRetry,
  processUrls,
  parseUrls,
  isPdfEncrypted,
  isValidUrl,
  sanitizeFileName,
  isApiConfigured,
  closeBrowser,
  getBrowser,
};