/**
 * PDF Generation Service using Puppeteer
 * Converts URLs and HTML to PDF using headless Chrome
 * Works on both local development and cloud environments (Railway, Render, etc.)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');

// Determine environment
const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;

let browser = null;

/**
 * Find Chrome/Chromium executable path
 */
function findChromePath() {
  // Check environment variable first
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  // Common paths to check
  const possiblePaths = [
    // Railway/Nixpacks
    '/nix/store/chromium/bin/chromium',
    // Linux
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    // Try to find via which command
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Try which command on Linux
  try {
    const chromiumPath = execSync('which chromium || which chromium-browser || which google-chrome', { encoding: 'utf8' }).trim();
    if (chromiumPath && fs.existsSync(chromiumPath)) {
      return chromiumPath;
    }
  } catch (e) {
    // Ignore errors
  }

  // Try to find in nix store (Railway)
  try {
    const nixPath = execSync('find /nix/store -name "chromium" -type f -executable 2>/dev/null | head -1', { encoding: 'utf8' }).trim();
    if (nixPath && fs.existsSync(nixPath)) {
      return nixPath;
    }
  } catch (e) {
    // Ignore errors
  }

  return null;
}

/**
 * Initialize Puppeteer with the right browser for the environment
 */
async function initBrowser() {
  if (browser) return browser;

  try {
    if (isProduction) {
      // Production: Use puppeteer-core with system Chrome
      const puppeteer = require('puppeteer-core');
      
      let executablePath = findChromePath();
      
      // If no system Chrome found, try @sparticuz/chromium as fallback
      if (!executablePath) {
        try {
          const chromium = require('@sparticuz/chromium');
          executablePath = await chromium.executablePath();
          console.log('Using @sparticuz/chromium');
        } catch (e) {
          throw new Error('No Chrome/Chromium found. Install chromium on the system or add @sparticuz/chromium package.');
        }
      }

      console.log(`Using Chrome at: ${executablePath}`);
      
      browser = await puppeteer.launch({
        executablePath: executablePath,
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-extensions',
        ],
        ignoreHTTPSErrors: true,
      });
      
      console.log('Puppeteer initialized (production mode)');
    } else {
      // Development: Use regular puppeteer with bundled Chrome
      const puppeteer = require('puppeteer');
      
      browser = await puppeteer.launch({
        headless: 'new',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920,1080',
        ],
        defaultViewport: {
          width: 1920,
          height: 1080,
        },
      });
      
      console.log('Puppeteer initialized with bundled Chrome (development mode)');
    }

    // Handle browser disconnection
    browser.on('disconnected', () => {
      console.log('Browser disconnected, will reinitialize on next request');
      browser = null;
    });

    return browser;
  } catch (error) {
    console.error('Failed to initialize browser:', error.message);
    throw error;
  }
}

/**
 * Get or create browser instance
 */
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await initBrowser();
  }
  return browser;
}

/**
 * Close browser instance
 */
async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    console.log('Browser closed');
  }
}

/**
 * Convert a URL to PDF
 * @param {string} url - The URL to convert
 * @param {object} options - Conversion options
 * @returns {Promise<object>} - Result with PDF buffer
 */
async function convertUrlToPdf(url, options = {}) {
  const {
    timeout = 60000,
    waitUntil = 'networkidle2',
    format = 'Letter',
    margin = { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
    printBackground = true,
    scale = 1,
    landscape = false,
    waitForSelector = null,
    delay = 1000, // Wait after page load for dynamic content
  } = options;

  let page = null;
  
  try {
    const browserInstance = await getBrowser();
    page = await browserInstance.newPage();

    // Set viewport
    await page.setViewport({ width: 1920, height: 1080 });

    // Set user agent to avoid bot detection
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Navigate to URL
    console.log(`Converting URL to PDF: ${url}`);
    await page.goto(url, {
      waitUntil: waitUntil,
      timeout: timeout,
    });

    // Wait for specific selector if provided
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: 10000 }).catch(() => {
        console.log(`Selector ${waitForSelector} not found, continuing anyway`);
      });
    }

    // Additional delay for dynamic content
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    // Generate PDF
    const pdfBuffer = await page.pdf({
      format: format,
      margin: margin,
      printBackground: printBackground,
      scale: scale,
      landscape: landscape,
      preferCSSPageSize: false,
    });

    // Get page title for filename
    const title = await page.title();
    const sanitizedTitle = title
      ? title.replace(/[^a-z0-9]/gi, '_').substring(0, 50)
      : 'document';

    return {
      success: true,
      pdfBuffer: pdfBuffer,
      fileName: `${sanitizedTitle}.pdf`,
      pageTitle: title,
      sourceUrl: url,
    };

  } catch (error) {
    console.error(`Failed to convert URL ${url}:`, error.message);
    return {
      success: false,
      error: error.message,
      sourceUrl: url,
    };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

/**
 * Convert HTML string to PDF
 * @param {string} html - HTML content
 * @param {object} options - Conversion options
 * @returns {Promise<object>} - Result with PDF buffer
 */
async function convertHtmlToPdf(html, options = {}) {
  const {
    format = 'Letter',
    margin = { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
    printBackground = true,
    scale = 1,
    landscape = false,
  } = options;

  let page = null;

  try {
    const browserInstance = await getBrowser();
    page = await browserInstance.newPage();

    await page.setContent(html, {
      waitUntil: 'networkidle0',
    });

    const pdfBuffer = await page.pdf({
      format: format,
      margin: margin,
      printBackground: printBackground,
      scale: scale,
      landscape: landscape,
    });

    return {
      success: true,
      pdfBuffer: pdfBuffer,
    };

  } catch (error) {
    console.error('Failed to convert HTML to PDF:', error.message);
    return {
      success: false,
      error: error.message,
    };
  } finally {
    if (page) {
      await page.close().catch(() => {});
    }
  }
}

/**
 * Convert multiple URLs to PDFs
 * @param {string[]} urls - Array of URLs
 * @param {object} options - Conversion options
 * @param {function} onProgress - Progress callback
 * @returns {Promise<object[]>} - Array of results
 */
async function convertMultipleUrls(urls, options = {}, onProgress = null) {
  const results = [];
  
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    
    if (onProgress) {
      onProgress({
        current: i + 1,
        total: urls.length,
        url: url,
        status: 'processing',
      });
    }

    const result = await convertUrlToPdf(url, options);
    results.push({
      ...result,
      index: i,
    });

    // Small delay between conversions to avoid overwhelming the browser
    if (i < urls.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return results;
}

/**
 * Convert URL to PDF with retry logic
 * @param {string} url - The URL to convert
 * @param {object} options - Conversion options
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<object>} - Result with PDF buffer
 */
async function convertUrlToPdfWithRetry(url, options = {}, maxRetries = 3) {
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await convertUrlToPdf(url, options);
      
      if (result.success) {
        return result;
      }
      
      lastError = result.error;
      console.log(`Attempt ${attempt}/${maxRetries} failed for ${url}: ${result.error}`);
      
      // Don't retry on certain errors
      if (result.error && (
        result.error.includes('net::ERR_NAME_NOT_RESOLVED') ||
        result.error.includes('net::ERR_CONNECTION_REFUSED') ||
        result.error.includes('invalid URL')
      )) {
        return result; // Don't retry DNS/connection errors
      }
      
    } catch (error) {
      lastError = error.message;
      console.log(`Attempt ${attempt}/${maxRetries} threw error for ${url}: ${error.message}`);
    }
    
    // Wait before retry with exponential backoff
    if (attempt < maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      console.log(`Waiting ${delay}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
      
      // Try to get a fresh browser on retry
      if (attempt >= 2) {
        try {
          await closeBrowser();
        } catch (e) {
          // Ignore close errors
        }
      }
    }
  }
  
  return {
    success: false,
    error: lastError || 'Max retries exceeded',
    sourceUrl: url,
  };
}

/**
 * Check if a PDF is encrypted/protected
 * @param {Buffer} pdfBuffer - PDF buffer to check
 * @returns {Promise<boolean>} - True if encrypted
 */
async function isPdfEncrypted(pdfBuffer) {
  try {
    await PDFDocument.load(pdfBuffer);
    return false;
  } catch (error) {
    if (error.message.includes('encrypted')) {
      return true;
    }
    throw error;
  }
}

/**
 * Get PDF page count
 * @param {Buffer} pdfBuffer - PDF buffer
 * @returns {Promise<number>} - Number of pages
 */
async function getPdfPageCount(pdfBuffer) {
  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    return pdfDoc.getPageCount();
  } catch (error) {
    console.error('Failed to get page count:', error.message);
    return 0;
  }
}

/**
 * Check if service is available
 */
async function isAvailable() {
  try {
    await getBrowser();
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get service status
 */
async function getStatus() {
  const available = await isAvailable();
  return {
    available,
    environment: isProduction ? 'production' : 'development',
    browserConnected: browser ? browser.isConnected() : false,
  };
}

// Cleanup on process exit
process.on('SIGINT', async () => {
  await closeBrowser();
  process.exit();
});

process.on('SIGTERM', async () => {
  await closeBrowser();
  process.exit();
});

module.exports = {
  convertUrlToPdf,
  convertUrlToPdfWithRetry,
  convertHtmlToPdf,
  convertMultipleUrls,
  isPdfEncrypted,
  getPdfPageCount,
  isAvailable,
  getStatus,
  closeBrowser,
  getBrowser,
};