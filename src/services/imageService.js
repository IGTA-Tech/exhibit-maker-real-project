/**
 * Image Service
 * Converts images (JPEG, JPG, PNG) to PDF pages using pdf-lib
 */

const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

// Supported image MIME types
const SUPPORTED_IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

/**
 * Check if a file is a supported image
 * @param {string} filePath - Path to the file
 * @returns {boolean}
 */
function isSupportedImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext in SUPPORTED_IMAGE_TYPES) return true;
  // Fallback: check magic bytes
  return detectImageType(filePath) !== null;
}

/**
 * Get image MIME type from file extension
 * @param {string} filePath - Path to the file
 * @returns {string|null}
 */
function getImageMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_IMAGE_TYPES[ext] || null;
}

/**
 * Detect image type by reading file magic bytes (header).
 * Works even when the file has no extension (e.g., multer uploads).
 *
 * @param {string|Buffer} filePathOrBuffer - Path to file or Buffer of image data
 * @returns {'jpg'|'png'|null}
 */
function detectImageType(filePathOrBuffer) {
  let header;
  if (Buffer.isBuffer(filePathOrBuffer)) {
    header = filePathOrBuffer.slice(0, 8);
  } else {
    if (!fs.existsSync(filePathOrBuffer)) return null;
    const fd = fs.openSync(filePathOrBuffer, 'r');
    header = Buffer.alloc(8);
    fs.readSync(fd, header, 0, 8, 0);
    fs.closeSync(fd);
  }

  // JPEG: starts with FF D8 FF
  if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) {
    return 'jpg';
  }

  // PNG: starts with 89 50 4E 47 0D 0A 1A 0A
  if (
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4E &&
    header[3] === 0x47 &&
    header[4] === 0x0D &&
    header[5] === 0x0A &&
    header[6] === 0x1A &&
    header[7] === 0x0A
  ) {
    return 'png';
  }

  return null;
}

/**
 * Determine the image format: first tries extension, then falls back to magic bytes.
 * @param {string} imagePath
 * @returns {'jpg'|'png'|null}
 */
function resolveImageFormat(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'jpg';
  if (ext === '.png') return 'png';
  // No extension or unrecognised — read file header
  return detectImageType(imagePath);
}

/**
 * Convert a single image file to a PDF.
 * The image is placed on a letter-size page, scaled to fit with margins.
 *
 * @param {string} imagePath - Path to the image file
 * @param {object} options - Conversion options
 * @param {string} [options.formatHint] - Force format: 'jpg' or 'png'
 * @returns {Promise<Buffer>} - PDF buffer
 */
async function convertImageToPdf(imagePath, options = {}) {
  const {
    pageWidth = 612,   // Letter width in points (8.5 inches)
    pageHeight = 792,  // Letter height in points (11 inches)
    margin = 36,       // 0.5 inch margin
    formatHint = null, // Optional: 'jpg' or 'png'
  } = options;

  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image file not found: ${imagePath}`);
  }

  const imageBytes = fs.readFileSync(imagePath);

  // Determine format: explicit hint > extension > magic bytes
  const format = formatHint || resolveImageFormat(imagePath) || detectImageType(imageBytes);

  if (!format) {
    throw new Error(
      `Cannot determine image format for: ${imagePath}. ` +
      `File has no recognised extension and magic bytes don't match JPEG or PNG.`
    );
  }

  console.log(`[imageService] Converting ${path.basename(imagePath)} as ${format.toUpperCase()}, ${imageBytes.length} bytes`);

  const pdfDoc = await PDFDocument.create();

  // Embed the image based on detected type
  let image;
  if (format === 'png') {
    image = await pdfDoc.embedPng(imageBytes);
  } else {
    // jpg / jpeg
    image = await pdfDoc.embedJpg(imageBytes);
  }

  // Calculate available area (page minus margins)
  const availableWidth = pageWidth - (margin * 2);
  const availableHeight = pageHeight - (margin * 2);

  // Get original image dimensions
  const imgWidth = image.width;
  const imgHeight = image.height;

  // Scale image to fit within available area while maintaining aspect ratio
  const widthRatio = availableWidth / imgWidth;
  const heightRatio = availableHeight / imgHeight;
  const scale = Math.min(widthRatio, heightRatio, 1); // Don't upscale

  const scaledWidth = imgWidth * scale;
  const scaledHeight = imgHeight * scale;

  // Center the image on the page
  const x = margin + (availableWidth - scaledWidth) / 2;
  const y = margin + (availableHeight - scaledHeight) / 2;

  // Add page and draw image
  const page = pdfDoc.addPage([pageWidth, pageHeight]);
  page.drawImage(image, {
    x,
    y,
    width: scaledWidth,
    height: scaledHeight,
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Convert an image file to PDF and save to disk
 *
 * @param {string} imagePath - Path to the image file
 * @param {string} outputPath - Path to save the PDF (optional, defaults to same name with .pdf)
 * @param {object} options - Conversion options
 * @returns {Promise<string>} - Path to the output PDF
 */
async function convertImageToPdfFile(imagePath, outputPath = null, options = {}) {
  if (!outputPath) {
    const dir = path.dirname(imagePath);
    const basename = path.basename(imagePath, path.extname(imagePath));
    outputPath = path.join(dir, `${basename}.pdf`);
  }

  const pdfBuffer = await convertImageToPdf(imagePath, options);
  fs.writeFileSync(outputPath, pdfBuffer);

  console.log(`[imageService] Saved PDF: ${outputPath} (${pdfBuffer.length} bytes)`);
  return outputPath;
}

/**
 * Convert multiple images to a single PDF (one image per page)
 *
 * @param {string[]} imagePaths - Array of image file paths
 * @param {object} options - Conversion options
 * @returns {Promise<Buffer>} - Combined PDF buffer
 */
async function convertMultipleImagesToPdf(imagePaths, options = {}) {
  const {
    pageWidth = 612,
    pageHeight = 792,
    margin = 36,
  } = options;

  const pdfDoc = await PDFDocument.create();
  const availableWidth = pageWidth - (margin * 2);
  const availableHeight = pageHeight - (margin * 2);

  for (const imagePath of imagePaths) {
    if (!fs.existsSync(imagePath)) {
      console.warn(`[imageService] Skipping missing image: ${imagePath}`);
      continue;
    }

    try {
      const imageBytes = fs.readFileSync(imagePath);
      const format = resolveImageFormat(imagePath) || detectImageType(imageBytes);

      if (!format) {
        console.warn(`[imageService] Skipping unrecognised format: ${imagePath}`);
        continue;
      }

      let image;
      if (format === 'png') {
        image = await pdfDoc.embedPng(imageBytes);
      } else {
        image = await pdfDoc.embedJpg(imageBytes);
      }

      const widthRatio = availableWidth / image.width;
      const heightRatio = availableHeight / image.height;
      const scale = Math.min(widthRatio, heightRatio, 1);

      const scaledWidth = image.width * scale;
      const scaledHeight = image.height * scale;

      const x = margin + (availableWidth - scaledWidth) / 2;
      const y = margin + (availableHeight - scaledHeight) / 2;

      const page = pdfDoc.addPage([pageWidth, pageHeight]);
      page.drawImage(image, {
        x,
        y,
        width: scaledWidth,
        height: scaledHeight,
      });
    } catch (error) {
      console.error(`[imageService] Error processing image ${imagePath}:`, error.message);
    }
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

module.exports = {
  isSupportedImage,
  getImageMimeType,
  detectImageType,
  resolveImageFormat,
  convertImageToPdf,
  convertImageToPdfFile,
  convertMultipleImagesToPdf,
  SUPPORTED_IMAGE_TYPES,
};