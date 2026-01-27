/**
 * PDF Compression Service using Ghostscript
 * Reduces PDF file sizes for email attachments
 */

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);

// Compression quality presets
const COMPRESSION_PRESETS = {
  screen: {
    name: 'screen',
    description: 'Lowest quality, smallest size (72 dpi) - best for screen viewing',
    setting: '/screen',
    expectedReduction: '70-90%'
  },
  ebook: {
    name: 'ebook',
    description: 'Medium quality (150 dpi) - good balance for email',
    setting: '/ebook',
    expectedReduction: '50-70%'
  },
  printer: {
    name: 'printer',
    description: 'High quality (300 dpi) - suitable for printing',
    setting: '/printer',
    expectedReduction: '20-40%'
  },
  prepress: {
    name: 'prepress',
    description: 'Highest quality (300 dpi, color preserving) - minimal compression',
    setting: '/prepress',
    expectedReduction: '10-20%'
  },
  default: {
    name: 'default',
    description: 'Default Ghostscript settings',
    setting: '/default',
    expectedReduction: '30-50%'
  }
};

// Default compression settings
const DEFAULT_PRESET = 'ebook';
const MAX_EMAIL_SIZE = 20 * 1024 * 1024; // 20MB (leaving buffer for email overhead)

/**
 * Check if Ghostscript is installed
 */
async function isGhostscriptInstalled() {
  try {
    await execAsync('gs --version');
    return true;
  } catch (error) {
    // Try alternative command names
    try {
      await execAsync('gswin64c --version');
      return true;
    } catch {
      try {
        await execAsync('gswin32c --version');
        return true;
      } catch {
        return false;
      }
    }
  }
}

/**
 * Get the Ghostscript command name for the current platform
 */
async function getGsCommand() {
  const commands = ['gs', 'gswin64c', 'gswin32c'];
  
  for (const cmd of commands) {
    try {
      await execAsync(`${cmd} --version`);
      return cmd;
    } catch {
      continue;
    }
  }
  
  throw new Error('Ghostscript is not installed. Please install it: https://ghostscript.com/releases/gsdnld.html');
}

/**
 * Compress a PDF file using Ghostscript
 * @param {string} inputPath - Path to input PDF
 * @param {string} outputPath - Path for compressed output (optional, will overwrite input if not provided)
 * @param {object} options - Compression options
 * @returns {Promise<object>} - Compression result with stats
 */
async function compressPdf(inputPath, outputPath = null, options = {}) {
  const {
    preset = DEFAULT_PRESET,
    quality = null, // Custom quality override (0-100)
    dpi = null, // Custom DPI override
    grayscale = false, // Convert to grayscale for smaller size
    removeMetadata = true, // Remove metadata to reduce size
  } = options;

  // Validate input file exists
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  // Get original file size
  const originalSize = fs.statSync(inputPath).size;

  // If no output path, create temp file then replace original
  const tempOutput = outputPath || inputPath + '.compressed.pdf';
  const finalOutput = outputPath || inputPath;

  try {
    const gsCommand = await getGsCommand();
    const presetConfig = COMPRESSION_PRESETS[preset] || COMPRESSION_PRESETS[DEFAULT_PRESET];

    // Build Ghostscript command
    let args = [
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.4',
      `-dPDFSETTINGS=${presetConfig.setting}`,
      '-dNOPAUSE',
      '-dQUIET',
      '-dBATCH',
      '-dSAFER',
    ];

    // Custom DPI override
    if (dpi) {
      args.push(`-dDownsampleColorImages=true`);
      args.push(`-dColorImageResolution=${dpi}`);
      args.push(`-dDownsampleGrayImages=true`);
      args.push(`-dGrayImageResolution=${dpi}`);
      args.push(`-dDownsampleMonoImages=true`);
      args.push(`-dMonoImageResolution=${dpi}`);
    }

    // Grayscale conversion
    if (grayscale) {
      args.push('-sColorConversionStrategy=Gray');
      args.push('-dProcessColorModel=/DeviceGray');
    }

    // Remove metadata
    if (removeMetadata) {
      args.push('-dFastWebView=false');
    }

    // Additional optimizations
    args.push('-dDetectDuplicateImages=true');
    args.push('-dCompressFonts=true');
    args.push('-dSubsetFonts=true');
    args.push('-dEmbedAllFonts=true');

    // Output and input files
    args.push(`-sOutputFile=${tempOutput}`);
    args.push(inputPath);

    // Execute Ghostscript
    const command = `${gsCommand} ${args.join(' ')}`;
    console.log(`Compressing PDF: ${path.basename(inputPath)}`);
    
    await execAsync(command, { timeout: 300000 }); // 5 minute timeout

    // Check if output was created
    if (!fs.existsSync(tempOutput)) {
      throw new Error('Compression failed - no output file created');
    }

    // Get compressed file size
    const compressedSize = fs.statSync(tempOutput).size;

    // If compressing in place, replace original
    if (!outputPath) {
      fs.unlinkSync(inputPath);
      fs.renameSync(tempOutput, finalOutput);
    }

    const reduction = ((originalSize - compressedSize) / originalSize * 100).toFixed(1);

    return {
      success: true,
      inputPath: inputPath,
      outputPath: finalOutput,
      originalSize,
      compressedSize,
      reduction: `${reduction}%`,
      reductionBytes: originalSize - compressedSize,
      preset: preset,
    };

  } catch (error) {
    // Clean up temp file on error
    if (fs.existsSync(tempOutput) && !outputPath) {
      try {
        fs.unlinkSync(tempOutput);
      } catch (e) {
        // Ignore cleanup error
      }
    }

    console.error('Compression error:', error.message);
    return {
      success: false,
      error: error.message,
      inputPath,
      originalSize,
    };
  }
}

/**
 * Compress PDF with automatic quality adjustment to meet size target
 * @param {string} inputPath - Path to input PDF
 * @param {string} outputPath - Path for compressed output
 * @param {number} targetSize - Target file size in bytes
 * @returns {Promise<object>} - Compression result
 */
async function compressToTargetSize(inputPath, outputPath = null, targetSize = MAX_EMAIL_SIZE) {
  const originalSize = fs.statSync(inputPath).size;

  // If already under target, just copy
  if (originalSize <= targetSize) {
    if (outputPath && outputPath !== inputPath) {
      fs.copyFileSync(inputPath, outputPath);
    }
    return {
      success: true,
      inputPath,
      outputPath: outputPath || inputPath,
      originalSize,
      compressedSize: originalSize,
      reduction: '0%',
      reductionBytes: 0,
      preset: 'none (already under target)',
    };
  }

  // Try compression presets from least to most aggressive
  const presetsToTry = ['printer', 'ebook', 'screen'];
  
  for (const preset of presetsToTry) {
    const tempPath = inputPath + `.${preset}.tmp.pdf`;
    
    const result = await compressPdf(inputPath, tempPath, { preset });
    
    if (result.success && result.compressedSize <= targetSize) {
      // Success! Move to final destination
      if (outputPath) {
        fs.renameSync(tempPath, outputPath);
      } else {
        fs.unlinkSync(inputPath);
        fs.renameSync(tempPath, inputPath);
      }
      
      return {
        ...result,
        outputPath: outputPath || inputPath,
        note: `Used '${preset}' preset to achieve target size`,
      };
    }
    
    // Clean up temp file
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }

  // If still too large, try screen with grayscale
  const grayscalePath = inputPath + '.grayscale.tmp.pdf';
  const grayscaleResult = await compressPdf(inputPath, grayscalePath, {
    preset: 'screen',
    grayscale: true,
    dpi: 72,
  });

  if (grayscaleResult.success) {
    if (outputPath) {
      fs.renameSync(grayscalePath, outputPath);
    } else {
      fs.unlinkSync(inputPath);
      fs.renameSync(grayscalePath, inputPath);
    }

    return {
      ...grayscaleResult,
      outputPath: outputPath || inputPath,
      note: grayscaleResult.compressedSize <= targetSize
        ? 'Used maximum compression with grayscale'
        : `Warning: Could not achieve target size. Final size: ${formatBytes(grayscaleResult.compressedSize)}`,
    };
  }

  // Clean up
  if (fs.existsSync(grayscalePath)) {
    fs.unlinkSync(grayscalePath);
  }

  return {
    success: false,
    error: 'Could not compress PDF to target size',
    originalSize,
    targetSize,
  };
}

/**
 * Compress multiple PDFs
 * @param {Array} pdfPaths - Array of PDF file paths
 * @param {object} options - Compression options
 * @returns {Promise<object>} - Results for all files
 */
async function compressMultiple(pdfPaths, options = {}) {
  const results = {
    success: [],
    failed: [],
    totalOriginalSize: 0,
    totalCompressedSize: 0,
  };

  for (const pdfPath of pdfPaths) {
    const result = await compressPdf(pdfPath, null, options);
    
    if (result.success) {
      results.success.push(result);
      results.totalOriginalSize += result.originalSize;
      results.totalCompressedSize += result.compressedSize;
    } else {
      results.failed.push(result);
      results.totalOriginalSize += result.originalSize || 0;
    }
  }

  results.totalReduction = results.totalOriginalSize > 0
    ? ((results.totalOriginalSize - results.totalCompressedSize) / results.totalOriginalSize * 100).toFixed(1) + '%'
    : '0%';

  return results;
}

/**
 * Get compression statistics for a PDF
 * @param {string} pdfPath - Path to PDF file
 * @returns {Promise<object>} - Estimated compression results for each preset
 */
async function analyzeCompression(pdfPath) {
  const originalSize = fs.statSync(pdfPath).size;
  const estimates = {};

  for (const [presetName, presetConfig] of Object.entries(COMPRESSION_PRESETS)) {
    estimates[presetName] = {
      ...presetConfig,
      originalSize,
      estimatedSize: `${presetConfig.expectedReduction} reduction`,
    };
  }

  return {
    originalSize,
    originalSizeFormatted: formatBytes(originalSize),
    presets: estimates,
    recommendation: originalSize > MAX_EMAIL_SIZE ? 'ebook' : 'printer',
  };
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * Get available compression presets
 */
function getPresets() {
  return COMPRESSION_PRESETS;
}

/**
 * Check compression service availability
 */
async function isAvailable() {
  return await isGhostscriptInstalled();
}

module.exports = {
  compressPdf,
  compressToTargetSize,
  compressMultiple,
  analyzeCompression,
  isGhostscriptInstalled,
  isAvailable,
  getPresets,
  formatBytes,
  COMPRESSION_PRESETS,
  MAX_EMAIL_SIZE,
  DEFAULT_PRESET,
};