/**
 * Exhibit Service
 * Handles exhibit cover page generation and packaging
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

/**
 * Create an exhibit cover page PDF
 * @param {number} exhibitNumber - The exhibit number (1, 2, 3, etc.)
 * @param {string} label - Optional label/description for the exhibit
 * @param {Object} options - Additional options
 * @returns {Promise<Buffer>} - PDF buffer
 */
async function createCoverPage(exhibitNumber, label = '', options = {}) {
  const {
    fontSize = 72,
    labelFontSize = 24,
    caseName = '',
    caseNameFontSize = 18,
  } = options;

  // Create a new PDF document
  const pdfDoc = await PDFDocument.create();

  // Add a page (letter size: 8.5 x 11 inches)
  const page = pdfDoc.addPage([612, 792]);

  // Get standard fonts
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const { width, height } = page.getSize();

  // Draw exhibit number
  const exhibitText = `EXHIBIT ${exhibitNumber}`;
  const exhibitTextWidth = helveticaBold.widthOfTextAtSize(exhibitText, fontSize);

  page.drawText(exhibitText, {
    x: (width - exhibitTextWidth) / 2,
    y: height / 2 + 50,
    size: fontSize,
    font: helveticaBold,
    color: rgb(0, 0, 0),
  });

  // Draw label if provided
  if (label) {
    // Word wrap the label if it's too long
    const maxWidth = width - 100;
    const words = label.split(' ');
    const lines = [];
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const testWidth = helvetica.widthOfTextAtSize(testLine, labelFontSize);

      if (testWidth > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }

    // Draw each line
    let yPosition = height / 2 - 30;
    for (const line of lines) {
      const lineWidth = helvetica.widthOfTextAtSize(line, labelFontSize);
      page.drawText(line, {
        x: (width - lineWidth) / 2,
        y: yPosition,
        size: labelFontSize,
        font: helvetica,
        color: rgb(0.3, 0.3, 0.3),
      });
      yPosition -= labelFontSize + 5;
    }
  }

  // Draw case name at bottom if provided
  if (caseName) {
    const caseNameWidth = helvetica.widthOfTextAtSize(caseName, caseNameFontSize);
    page.drawText(caseName, {
      x: (width - caseNameWidth) / 2,
      y: 50,
      size: caseNameFontSize,
      font: helvetica,
      color: rgb(0.5, 0.5, 0.5),
    });
  }

  // Serialize the PDF to bytes
  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Add a cover page to an existing PDF
 * @param {string} pdfPath - Path to the PDF file
 * @param {number} exhibitNumber - The exhibit number
 * @param {string} label - Optional label for the exhibit
 * @param {Object} options - Additional options
 * @returns {Promise<Buffer>} - Combined PDF buffer
 */
async function addCoverPageToPdf(pdfPath, exhibitNumber, label = '', options = {}) {
  try {
    // Create the cover page
    const coverPageBytes = await createCoverPage(exhibitNumber, label, options);
    const coverDoc = await PDFDocument.load(coverPageBytes);

    // Load the existing PDF
    const existingPdfBytes = fs.readFileSync(pdfPath);
    let existingDoc;

    try {
      existingDoc = await PDFDocument.load(existingPdfBytes, {
        ignoreEncryption: true,
      });
    } catch (error) {
      // If the PDF is encrypted or corrupted, just return the cover page
      console.error(`Cannot process PDF ${pdfPath}: ${error.message}`);
      return coverPageBytes;
    }

    // Create a new document with the cover page first
    const mergedDoc = await PDFDocument.create();

    // Copy the cover page
    const [coverPage] = await mergedDoc.copyPages(coverDoc, [0]);
    mergedDoc.addPage(coverPage);

    // Copy all pages from the existing PDF
    const pageIndices = existingDoc.getPageIndices();
    const copiedPages = await mergedDoc.copyPages(existingDoc, pageIndices);
    copiedPages.forEach((page) => mergedDoc.addPage(page));

    // Serialize and return
    const mergedPdfBytes = await mergedDoc.save();
    return Buffer.from(mergedPdfBytes);
  } catch (error) {
    console.error(`Error adding cover page: ${error.message}`);
    throw error;
  }
}

/**
 * Get exhibit number in the specified style
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
 * Process multiple PDFs and add exhibit cover pages
 * @param {Array} pdfFiles - Array of {path, label, id, order} objects
 * @param {string} numberingStyle - 'letters', 'numbers', or 'roman'
 * @param {string} outputDir - Directory to save processed PDFs
 * @param {Object} options - Additional options including caseName
 * @returns {Promise<Array>} - Array of processed file info
 */
async function processExhibits(pdfFiles, numberingStyle = 'letters', outputDir, options = {}) {
  const results = [];

  for (let i = 0; i < pdfFiles.length; i++) {
    const pdf = pdfFiles[i];
    const exhibitNum = getExhibitNumber(i, numberingStyle);
    const outputFileName = `Exhibit_${exhibitNum}_${path.basename(pdf.path)}`;
    const outputPath = path.join(outputDir, outputFileName);

    try {
      // Read original PDF to get page count
      const originalBytes = fs.readFileSync(pdf.path);
      let pageCount = 1;
      try {
        const doc = await PDFDocument.load(originalBytes, { ignoreEncryption: true });
        pageCount = doc.getPageCount();
      } catch (e) {
        // Ignore
      }

      const processedPdf = await addCoverPageToPdf(
        pdf.path,
        exhibitNum,
        pdf.label || '',
        options
      );

      fs.writeFileSync(outputPath, processedPdf);

      results.push({
        ...pdf,
        success: true,
        exhibitNumber: exhibitNum,
        processedPath: outputPath,
        pageCount: pageCount + 1, // +1 for cover page
      });
    } catch (error) {
      results.push({
        ...pdf,
        success: false,
        exhibitNumber: exhibitNum,
        error: error.message,
        processedPath: pdf.path, // Fall back to original
        pageCount: 1
      });
    }
  }

  return results;
}

/**
 * Create a combined PDF with all exhibits
 * @param {Array} exhibitPaths - Array of paths to exhibit PDFs (already processed)
 * @param {string} outputPath - Path for the combined PDF
 * @returns {Promise<string>} - Path to the combined PDF
 */
async function combineExhibits(exhibitPaths, outputPath) {
  const mergedDoc = await PDFDocument.create();

  for (const pdfPath of exhibitPaths) {
    try {
      const pdfBytes = fs.readFileSync(pdfPath);
      const pdf = await PDFDocument.load(pdfBytes, {
        ignoreEncryption: true,
      });

      const pageIndices = pdf.getPageIndices();
      const copiedPages = await mergedDoc.copyPages(pdf, pageIndices);
      copiedPages.forEach((page) => mergedDoc.addPage(page));
    } catch (error) {
      console.error(`Error loading ${pdfPath}: ${error.message}`);
      // Continue with other PDFs
    }
  }

  const mergedPdfBytes = await mergedDoc.save();
  fs.writeFileSync(outputPath, mergedPdfBytes);

  return outputPath;
}

module.exports = {
  createCoverPage,
  addCoverPageToPdf,
  processExhibits,
  combineExhibits,
};
