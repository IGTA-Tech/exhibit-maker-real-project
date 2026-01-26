/**
 * Table of Contents Generator
 * Creates a table of contents for exhibit packages
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');

/**
 * Generate a table of contents PDF
 * @param {Array} exhibits - Array of exhibit info {exhibitNumber, label, pageCount, url}
 * @param {Object} options - Additional options
 * @returns {Promise<Buffer>} - PDF buffer
 */
async function generateTocPdf(exhibits, options = {}) {
  const {
    title = 'TABLE OF CONTENTS',
    caseName = '',
    includeUrls = false,
    includePageNumbers = true,
  } = options;

  const pdfDoc = await PDFDocument.create();
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const pageWidth = 612;
  const pageHeight = 792;
  const margin = 50;
  const lineHeight = 20;
  const headerHeight = 100;

  let currentPage = null;
  let yPosition = 0;
  let currentPageNum = 0;

  // Helper to add a new page
  const addNewPage = () => {
    currentPage = pdfDoc.addPage([pageWidth, pageHeight]);
    currentPageNum++;
    yPosition = pageHeight - margin;

    // Draw title on first page only
    if (currentPageNum === 1) {
      const titleWidth = helveticaBold.widthOfTextAtSize(title, 24);
      currentPage.drawText(title, {
        x: (pageWidth - titleWidth) / 2,
        y: yPosition,
        size: 24,
        font: helveticaBold,
        color: rgb(0, 0, 0),
      });
      yPosition -= 30;

      // Draw case name if provided
      if (caseName) {
        const caseNameWidth = helvetica.widthOfTextAtSize(caseName, 14);
        currentPage.drawText(caseName, {
          x: (pageWidth - caseNameWidth) / 2,
          y: yPosition,
          size: 14,
          font: helvetica,
          color: rgb(0.4, 0.4, 0.4),
        });
        yPosition -= 20;
      }

      // Draw separator line
      yPosition -= 10;
      currentPage.drawLine({
        start: { x: margin, y: yPosition },
        end: { x: pageWidth - margin, y: yPosition },
        thickness: 1,
        color: rgb(0.8, 0.8, 0.8),
      });
      yPosition -= 30;
    }

    return currentPage;
  };

  // Start first page
  addNewPage();

  // Draw exhibit entries
  for (const exhibit of exhibits) {
    // Check if we need a new page
    if (yPosition < margin + lineHeight * 2) {
      addNewPage();
    }

    // Exhibit number
    const exhibitLabel = `Exhibit ${exhibit.exhibitNumber}`;
    currentPage.drawText(exhibitLabel, {
      x: margin,
      y: yPosition,
      size: 12,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });

    // Description/label
    const labelX = margin + 100;
    const maxLabelWidth = pageWidth - margin - labelX - 50;
    let labelText = exhibit.label || exhibit.fileName || 'Untitled';

    // Truncate if too long
    while (
      helvetica.widthOfTextAtSize(labelText, 11) > maxLabelWidth &&
      labelText.length > 10
    ) {
      labelText = labelText.substring(0, labelText.length - 4) + '...';
    }

    currentPage.drawText(labelText, {
      x: labelX,
      y: yPosition,
      size: 11,
      font: helvetica,
      color: rgb(0.2, 0.2, 0.2),
    });

    // Page number if provided
    if (includePageNumbers && exhibit.startPage) {
      const pageText = `Page ${exhibit.startPage}`;
      const pageTextWidth = helvetica.widthOfTextAtSize(pageText, 10);
      currentPage.drawText(pageText, {
        x: pageWidth - margin - pageTextWidth,
        y: yPosition,
        size: 10,
        font: helvetica,
        color: rgb(0.5, 0.5, 0.5),
      });
    }

    yPosition -= lineHeight;

    // URL if requested
    if (includeUrls && exhibit.url) {
      let urlText = exhibit.url;
      if (urlText.length > 80) {
        urlText = urlText.substring(0, 77) + '...';
      }

      currentPage.drawText(urlText, {
        x: labelX,
        y: yPosition,
        size: 8,
        font: helvetica,
        color: rgb(0.4, 0.4, 0.6),
      });
      yPosition -= lineHeight * 0.8;
    }

    // Add spacing between entries
    yPosition -= 5;
  }

  // Add footer with date
  const footerText = `Generated: ${new Date().toLocaleDateString()}`;
  const footerWidth = helvetica.widthOfTextAtSize(footerText, 9);

  // Add footer to all pages
  const pages = pdfDoc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];

    // Page number
    const pageNumText = `Page ${i + 1} of ${pages.length}`;
    const pageNumWidth = helvetica.widthOfTextAtSize(pageNumText, 9);

    page.drawText(pageNumText, {
      x: pageWidth - margin - pageNumWidth,
      y: 30,
      size: 9,
      font: helvetica,
      color: rgb(0.5, 0.5, 0.5),
    });

    page.drawText(footerText, {
      x: margin,
      y: 30,
      size: 9,
      font: helvetica,
      color: rgb(0.5, 0.5, 0.5),
    });
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Generate a text-based table of contents
 * @param {Array} exhibits - Array of exhibit info
 * @param {Object} options - Additional options
 * @returns {string} - Text content
 */
function generateTocText(exhibits, options = {}) {
  const { caseName = '', includeUrls = true } = options;

  let content = '';
  content += '='.repeat(80) + '\n';
  content += '                          TABLE OF CONTENTS\n';
  content += '='.repeat(80) + '\n';

  if (caseName) {
    content += `Case: ${caseName}\n`;
  }

  content += `Generated: ${new Date().toISOString()}\n`;
  content += `Total Exhibits: ${exhibits.length}\n`;
  content += '='.repeat(80) + '\n\n';

  for (const exhibit of exhibits) {
    content += `EXHIBIT ${String(exhibit.exhibitNumber).padStart(3, '0')}\n`;
    content += `-`.repeat(40) + '\n';
    content += `  Label: ${exhibit.label || exhibit.fileName || 'Untitled'}\n`;

    if (exhibit.fileName) {
      content += `  File: ${exhibit.fileName}\n`;
    }

    if (includeUrls && exhibit.url) {
      content += `  Source: ${exhibit.url}\n`;
    }

    if (exhibit.pageCount) {
      content += `  Pages: ${exhibit.pageCount}\n`;
    }

    content += '\n';
  }

  content += '='.repeat(80) + '\n';
  content += 'END OF TABLE OF CONTENTS\n';
  content += '='.repeat(80) + '\n';

  return content;
}

/**
 * Save table of contents to file
 * @param {Array} exhibits - Array of exhibit info
 * @param {string} outputPath - Path to save the TOC
 * @param {string} format - 'pdf' or 'txt'
 * @param {Object} options - Additional options
 */
async function saveToc(exhibits, outputPath, format = 'txt', options = {}) {
  if (format === 'pdf') {
    const pdfBuffer = await generateTocPdf(exhibits, options);
    fs.writeFileSync(outputPath, pdfBuffer);
  } else {
    const textContent = generateTocText(exhibits, options);
    fs.writeFileSync(outputPath, textContent, 'utf8');
  }

  return outputPath;
}

module.exports = {
  generateTocPdf,
  generateTocText,
  saveToc,
};
