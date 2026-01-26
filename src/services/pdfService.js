const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.API2PDF_API_KEY;

// Log API key status on startup (for debugging)
if (!API_KEY) {
  console.warn('⚠️ WARNING: API2PDF_API_KEY is not configured. URL-to-PDF conversion will not work.');
} else {
  console.log('✓ API2PDF_API_KEY configured (length: ' + API_KEY.length + ')');
}

/**
 * Check if API is configured and working
 */
function isApiConfigured() {
  return !!API_KEY && API_KEY.length > 10;
}

// Common errors that indicate retry might help
const RETRYABLE_ERRORS = [
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'Request timeout',
  'socket hang up',
  'Internal Server Error',
  '500',
  '502',
  '503',
  '504',
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
  return RETRYABLE_ERRORS.some(e => errorStr.includes(e.toLowerCase()));
}

/**
 * Convert a single URL to PDF using api2pdf
 */
async function convertUrlToPdf(url, fileName, options = {}) {
  return new Promise((resolve, reject) => {
    if (!API_KEY) {
      resolve({ success: false, error: 'API2PDF_API_KEY not configured', fileName });
      return;
    }

    const postData = JSON.stringify({
      url: url,
      inline: false,
      fileName: fileName,
      options: {
        delay: options.delay || 3000,
        width: options.width || '1920px',
        height: options.height || '1080px',
        ...options
      }
    });

    const reqOptions = {
      hostname: 'v2.api2pdf.com',
      port: 443,
      path: '/chrome/pdf/url',
      method: 'POST',
      headers: {
        'Authorization': API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          if (response.FileUrl) {
            resolve({ success: true, fileUrl: response.FileUrl, fileName });
          } else {
            const errorMsg = response.Error || response.error || response.message || 'Unknown API error';
            resolve({
              success: false,
              error: errorMsg,
              fileName,
              retryable: isRetryableError(errorMsg)
            });
          }
        } catch (e) {
          resolve({ success: false, error: `JSON parse error: ${e.message}`, fileName });
        }
      });
    });

    req.on('error', (e) => {
      resolve({
        success: false,
        error: e.message,
        fileName,
        retryable: isRetryableError(e.message)
      });
    });

    req.setTimeout(60000, () => {
      req.destroy();
      resolve({ success: false, error: 'Request timeout', fileName, retryable: true });
    });

    req.write(postData);
    req.end();
  });
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
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff
      console.log(`Retry ${attempt}/${maxRetries} for ${fileName} after ${delay}ms`);
      await sleep(delay);
    }
  }

  return { success: false, error: lastError || 'Max retries exceeded', fileName };
}

/**
 * Download PDF from URL to local file
 */
async function downloadPdf(pdfUrl, localPath) {
  return new Promise((resolve, reject) => {
    const protocol = pdfUrl.startsWith('https') ? https : http;

    const file = fs.createWriteStream(localPath);

    const request = protocol.get(pdfUrl, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Follow redirect
        const redirectUrl = response.headers.location;
        const redirectProtocol = redirectUrl.startsWith('https') ? https : http;

        redirectProtocol.get(redirectUrl, (redirectResponse) => {
          redirectResponse.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve(localPath);
          });
        }).on('error', (err) => {
          fs.unlink(localPath, () => {});
          reject(err);
        });
      } else if (response.statusCode === 200) {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(localPath);
        });
      } else {
        fs.unlink(localPath, () => {});
        reject(new Error(`HTTP ${response.statusCode}`));
      }
    });

    request.on('error', (err) => {
      fs.unlink(localPath, () => {});
      reject(err);
    });

    request.setTimeout(120000, () => {
      request.destroy();
      fs.unlink(localPath, () => {});
      reject(new Error('Download timeout'));
    });
  });
}

/**
 * Download PDF with retry logic
 */
async function downloadPdfWithRetry(pdfUrl, localPath, maxRetries = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await downloadPdf(pdfUrl, localPath);
    } catch (error) {
      lastError = error;

      if (!isRetryableError(error.message)) {
        throw error;
      }

      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        console.log(`Download retry ${attempt}/${maxRetries} after ${delay}ms`);
        await sleep(delay);
      }
    }
  }

  throw lastError || new Error('Max retries exceeded');
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

    // Check for password protected marker
    if (content.includes('/Encrypt ') || content.includes('/Encrypt\n') || content.includes('/Encrypt\r')) {
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

  const batchSize = 5;
  const delayBetweenBatches = 2000;

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

    const batchPromises = batch.map(async (item, idx) => {
      const index = i + idx + 1;
      const fileName = item.fileName || `PDF_${String(index).padStart(3, '0')}.pdf`;

      try {
        // Convert URL to PDF with retry
        const result = await convertUrlToPdfWithRetry(item.url, fileName);

        if (result.success) {
          // Download the PDF with retry
          const localPath = path.join(outputDir, fileName);
          await downloadPdfWithRetry(result.fileUrl, localPath);

          // Check if PDF is encrypted
          if (await isPdfEncrypted(localPath)) {
            // Skip encrypted PDF but keep the file
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
    });

    await Promise.all(batchPromises);

    // Delay between batches (except for last batch)
    if (i + batchSize < urls.length) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
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
  isApiConfigured
};
