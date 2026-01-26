const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.API2PDF_API_KEY;

/**
 * Convert a single URL to PDF using api2pdf
 */
async function convertUrlToPdf(url, fileName, options = {}) {
  return new Promise((resolve, reject) => {
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
            resolve({
              success: false,
              error: response.Error || response.error || 'Unknown API error',
              fileName
            });
          }
        } catch (e) {
          resolve({ success: false, error: `JSON parse error: ${e.message}`, fileName });
        }
      });
    });

    req.on('error', (e) => {
      resolve({ success: false, error: e.message, fileName });
    });

    req.setTimeout(60000, () => {
      req.destroy();
      resolve({ success: false, error: 'Request timeout', fileName });
    });

    req.write(postData);
    req.end();
  });
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
 * Process multiple URLs with rate limiting
 */
async function processUrls(urls, outputDir, onProgress) {
  const results = {
    success: [],
    failed: [],
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
        // Convert URL to PDF
        const result = await convertUrlToPdf(item.url, fileName);

        if (result.success) {
          // Download the PDF
          const localPath = path.join(outputDir, fileName);
          await downloadPdf(result.fileUrl, localPath);

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
            urls.push({ url: item, fileName: `PDF_${String(idx + 1).padStart(3, '0')}.pdf` });
          } else if (item.url) {
            urls.push({
              url: item.url,
              fileName: item.fileName || item.name || `PDF_${String(idx + 1).padStart(3, '0')}.pdf`,
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

      if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
        urls.push({
          url: url,
          label: parts[1] || '',
          fileName: parts[2] || `PDF_${String(idx + 1).padStart(3, '0')}.pdf`
        });
      }
    });
  }

  return urls;
}

module.exports = {
  convertUrlToPdf,
  downloadPdf,
  processUrls,
  parseUrls
};
