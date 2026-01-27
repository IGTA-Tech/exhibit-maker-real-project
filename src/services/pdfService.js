/**
 * PDF Generation Service using Puppeteer
 * Converts URLs and HTML to PDF using headless Chrome
 * Works on both local development and cloud environments (Railway, Render, etc.)
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

// Determine environment
const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;

let browser = null;

/**
 * Initialize Puppeteer with the right browser for the environment
 */
async function initBrowser() {
  if (browser) return browser;

  try {
    if (isProduction) {
      // Production: Use puppeteer-core with system Chromium
      const puppeteer = require('puppeteer-core');
      
      const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
      
      console.log(`Launching Chrome from: ${executablePath}`);
      
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
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--hide-scrollbars',
          '--metrics-recording-only',
          '--mute-audio',
          '--safebrowsing-disable-auto-update',
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
    waitUntil = 'load', // Changed from networkidle2 to avoid frame detachment issues
    format = 'Letter',
    margin = { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' },
    printBackground = true,
    scale = 1,
    landscape = false,
    waitForSelector = null,
    delay = 2000, // Increased delay for dynamic content
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

    // Block unnecessary resources to speed up loading and avoid frame issues
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      // Block videos, media, and some heavy resources
      if (['media', 'websocket', 'manifest', 'other'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Navigate to URL with retry on frame detachment
    console.log(`Converting URL to PDF: ${url}`);
    
    let response;
    try {
      response = await page.goto(url, {
        waitUntil: waitUntil,
        timeout: timeout,
      });
    } catch (navError) {
      // If frame detached, try again with simpler wait condition
      if (navError.message.includes('frame was detached') || navError.message.includes('Navigating frame')) {
        console.log('Frame detached, retrying with domcontentloaded...');
        await page.close().catch(() => {});
        page = await browserInstance.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: timeout,
        });
      } else {
        throw navError;
      }
    }

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

    // Wait for page to be stable (no more than 2 network connections for 500ms)
    await page.evaluate(() => {
      return new Promise((resolve) => {
        if (document.readyState === 'complete') {
          resolve();
        } else {
          window.addEventListener('load', resolve);
          // Fallback timeout
          setTimeout(resolve, 3000);
        }
      });
    }).catch(() => {});

    // Generate PDF
    const pdfBuffer = await page.pdf({
      format: format,
      margin: margin,
      printBackground: printBackground,
      scale: scale,
      landscape: landscape,
      preferCSSPageSize: false,
      timeout: 60000,
    });

    // Get page title for filename
    const title = await page.title().catch(() => 'document');
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