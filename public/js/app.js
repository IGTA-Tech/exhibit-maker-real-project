/**
 * Visa Exhibit Maker - Frontend Application
 * Full-featured exhibit package generator with:
 * - PDF uploads
 * - Image uploads (JPEG, JPG, PNG) - auto-converted to PDF
 * - URL to PDF conversion
 * - Drag-and-drop reordering
 * - Exhibit numbering (Letters, Numbers, Roman)
 * - AI classification
 * - Table of Contents
 * - Cover pages
 */

// ============================================
// State Management
// ============================================
const state = {
  currentStage: 1,
  exhibits: [], // Array of exhibit objects
  orderHistory: [], // For undo functionality
  sortableInstance: null,
  packageResult: null
};

// Exhibit object structure:
// {
//   id: string,
//   type: 'pdf' | 'image' | 'url',
//   file: File | null,
//   url: string | null,
//   label: string,
//   filename: string,
//   size: number,
//   classification: string | null,
//   confidence: number | null
// }

// Allowed file types
const ALLOWED_FILE_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/png': 'image',
};

const ALLOWED_EXTENSIONS = ['.pdf', '.jpg', '.jpeg', '.png'];

// ============================================
// Utility Functions
// ============================================

function escapeHtml(text) {
  if (typeof text !== 'string') return String(text);
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function generateId() {
  return 'ex_' + Math.random().toString(36).substr(2, 9);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

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

function getFileExtension(filename) {
  return '.' + filename.split('.').pop().toLowerCase();
}

function getFileTypeFromFile(file) {
  // Check MIME type first
  if (ALLOWED_FILE_TYPES[file.type]) {
    return ALLOWED_FILE_TYPES[file.type];
  }
  // Fallback to extension check
  const ext = getFileExtension(file.name);
  if (['.jpg', '.jpeg', '.png'].includes(ext)) {
    return 'image';
  }
  if (ext === '.pdf') {
    return 'pdf';
  }
  return null;
}

function getFileIcon(type) {
  switch (type) {
    case 'pdf': return '📄';
    case 'image': return '🖼️';
    case 'url': return '🔗';
    default: return '📎';
  }
}

function showNotification(message, type = 'info') {
  const container = document.getElementById('notifications');
  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  container.appendChild(notification);

  setTimeout(() => {
    notification.style.opacity = '0';
    setTimeout(() => notification.remove(), 300);
  }, 5000);
}

// ============================================
// URL Parsing (Robust / Flexible)
// ============================================

/**
 * Extract ALL URLs from a line of text.
 * Handles multiple URLs per line, including concatenated URLs with no space
 * e.g. "https://a.com/pagehttps://b.com/page" → two separate URLs.
 *
 * Returns an array of valid URL strings (may be empty).
 */
function extractUrlsFromLine(line) {
  if (!line || !line.includes('http')) return [];

  // Split the line on every occurrence of http:// or https://
  // This handles concatenated URLs like "https://a.comhttps://b.com"
  // by re-inserting the protocol before each chunk.
  const chunks = line.split(/(?=https?:\/\/)/gi);

  const urls = [];

  for (let chunk of chunks) {
    // Extract the URL portion (stop at whitespace or known delimiters)
    const urlMatch = chunk.match(/^(https?:\/\/[^\s,;""''<>\[\](){}]+)/i);
    if (!urlMatch) continue;

    let url = urlMatch[1];

    // Clean trailing punctuation that isn't part of a URL
    url = url.replace(/[.,;:!?)}\]]+$/, '');

    // Validate
    try {
      new URL(url);
      urls.push(url);
    } catch {
      // Skip invalid URLs
    }
  }

  return urls;
}

/**
 * Extract a label from the text surrounding a URL on its line.
 * Handles formats like:
 *   1. https://example.com — Some Label
 *   https://example.com - Some Label
 *   https://example.com, Some Label
 *   3. https://example.com — Some Label — extra note
 *   Some Label: https://example.com
 */
function extractLabelFromLine(line, url) {
  if (!url) return '';

  // Remove the URL from the line to work with the remaining text
  let remaining = line.replace(url, '|||URL|||');

  // Remove leading numbering like "1.", "2)", "12.", "#3", "- ", "* "
  remaining = remaining.replace(/^\s*[\d#]+[.):\-]?\s*/, '');
  // Remove bullet points
  remaining = remaining.replace(/^\s*[-*•]\s*/, '');

  // Split on the URL placeholder
  const parts = remaining.split('|||URL|||');
  const before = (parts[0] || '').trim();
  const after = (parts[1] || '').trim();

  // The label is usually AFTER the URL, separated by — , – , - , or ,
  let label = '';

  if (after) {
    // Strip leading separators: — – - , : |
    label = after.replace(/^[\s—–\-,;:|]+/, '').trim();
  }

  // If no label found after URL, check before URL
  if (!label && before) {
    label = before.replace(/[\s—–\-,;:|]+$/, '').trim();
  }

  // Clean up: remove quotes, extra whitespace
  label = label.replace(/^["']+|["']+$/g, '').trim();
  label = label.replace(/\s+/g, ' ');

  return label;
}

/**
 * Parse a block of user-pasted text into an array of {url, label} objects.
 * Handles many real-world formats:
 *   - Numbered lists (1. url — label)
 *   - Bullet lists (- url — label)
 *   - Plain URLs (one per line)
 *   - CSV-style (url, label)
 *   - Section headers (AWARDS, MEMBERSHIP, etc. — skipped)
 *   - Mixed content with URLs embedded in sentences
 *   - Multiple URLs on one line (including concatenated with no space)
 */
function parseUrlsFromText(text) {
  if (!text || typeof text !== 'string') return [];

  const lines = text.split(/\r?\n/);
  const results = [];
  let currentSection = ''; // Track section headers for context

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip empty lines
    if (!line) continue;

    // Detect section headers: lines that are ALL CAPS with no URL
    // e.g. "AWARDS", "MEMBERSHIP", "PUBLISHED MATERIAL"
    if (/^[A-Z][A-Z\s/&]+$/.test(line) && !line.includes('http')) {
      currentSection = line;
      continue;
    }

    // Extract all URLs from this line (handles concatenated URLs too)
    const urls = extractUrlsFromLine(line);
    if (urls.length === 0) continue;

    if (urls.length === 1) {
      // Single URL on the line — try to extract a label from surrounding text
      let label = extractLabelFromLine(line, urls[0]);
      if (!label) {
        label = extractLabelFromUrl(urls[0]);
      }
      results.push({ url: urls[0], label });
    } else {
      // Multiple URLs on the same line — each gets its own entry
      // Labels are derived from the URL path since there's no clear
      // way to assign surrounding text to a specific URL
      for (const url of urls) {
        results.push({ url, label: extractLabelFromUrl(url) });
      }
    }
  }

  return results;
}

/**
 * Count valid URLs in a text block (for the live counter).
 */
function countUrls(text) {
  return parseUrlsFromText(text).length;
}

/**
 * Add parsed URLs to the exhibits list.
 */
function addUrlsToExhibits() {
  const text = urlInput.value.trim();
  if (!text) {
    showNotification('Please enter some URLs first', 'error');
    return;
  }

  const parsed = parseUrlsFromText(text);

  if (parsed.length === 0) {
    showNotification('No valid URLs found in the input. Make sure each URL starts with http:// or https://', 'error');
    return;
  }

  let added = 0;

  for (const item of parsed) {
    const exhibit = {
      id: generateId(),
      type: 'url',
      file: null,
      url: item.url,
      label: item.label,
      filename: `${item.label}.pdf`,
      size: 0,
      classification: null,
      confidence: null
    };

    state.exhibits.push(exhibit);
    added++;
  }

  if (added > 0) {
    urlInput.value = '';
    document.getElementById('urlCount').textContent = '0 URLs detected';
    updateFilesList();
    updateContinueButton();
    showNotification(`Added ${added} URL(s) for conversion`, 'success');
  }
}

// ============================================
// Stage Navigation
// ============================================

function goToStage(stageNum) {
  // Validate transition
  if (stageNum > 1 && state.exhibits.length === 0) {
    showNotification('Please upload at least one document first', 'error');
    return;
  }

  // Update state
  state.currentStage = stageNum;

  // Update navigation UI
  document.querySelectorAll('.stage').forEach((stage, index) => {
    stage.classList.remove('active', 'completed');
    if (index + 1 < stageNum) {
      stage.classList.add('completed');
    } else if (index + 1 === stageNum) {
      stage.classList.add('active');
    }
  });

  // Show/hide stage content
  document.querySelectorAll('.stage-content').forEach(content => {
    content.classList.remove('active');
  });
  document.getElementById(`stage-${stageNum}`).classList.add('active');

  // Stage-specific initialization
  if (stageNum === 2) {
    renderReviewList();
  } else if (stageNum === 3) {
    renderReorderList();
  } else if (stageNum === 4) {
    updateGenerateSummary();
  }

  // Scroll to top
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Make stage navigation clickable
document.querySelectorAll('.stage').forEach(stage => {
  stage.addEventListener('click', () => {
    const targetStage = parseInt(stage.dataset.stage);
    if (targetStage <= state.currentStage || state.exhibits.length > 0) {
      goToStage(targetStage);
    }
  });
});

// ============================================
// Stage 1: Upload
// ============================================

// Upload tab switching
document.querySelectorAll('.upload-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.upload-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.upload-content').forEach(c => c.classList.remove('active'));

    tab.classList.add('active');
    document.getElementById(`upload-${tab.dataset.uploadTab}`).classList.add('active');
  });
});

// File upload (PDFs + Images)
const fileDropZone = document.getElementById('fileDropZone');
const docFilesInput = document.getElementById('docFiles');

fileDropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileDropZone.classList.add('dragover');
});

fileDropZone.addEventListener('dragleave', () => {
  fileDropZone.classList.remove('dragover');
});

fileDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDropZone.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});

docFilesInput.addEventListener('change', (e) => {
  handleFiles(e.target.files);
  // Reset input so the same file can be selected again
  e.target.value = '';
});

function handleFiles(files) {
  let addedCount = 0;
  let skippedCount = 0;

  for (const file of files) {
    const fileType = getFileTypeFromFile(file);

    if (!fileType) {
      showNotification(`Skipping "${file.name}" — unsupported file type. Use PDF, JPEG, JPG, or PNG.`, 'error');
      skippedCount++;
      continue;
    }

    const exhibit = {
      id: generateId(),
      type: fileType,       // 'pdf' or 'image'
      file: file,
      url: null,
      label: file.name.replace(/\.(pdf|jpe?g|png)$/i, ''),
      filename: file.name,
      size: file.size,
      classification: null,
      confidence: null
    };

    state.exhibits.push(exhibit);
    addedCount++;
  }

  updateFilesList();
  updateContinueButton();

  if (addedCount > 0) {
    const types = [];
    const pdfCount = Array.from(files).filter(f => getFileTypeFromFile(f) === 'pdf').length;
    const imgCount = Array.from(files).filter(f => getFileTypeFromFile(f) === 'image').length;
    if (pdfCount > 0) types.push(`${pdfCount} PDF(s)`);
    if (imgCount > 0) types.push(`${imgCount} image(s)`);
    showNotification(`Added ${types.join(' and ')}`, 'success');
  }
  if (skippedCount > 0 && addedCount === 0) {
    showNotification('No supported files found. Please use PDF, JPEG, JPG, or PNG files.', 'error');
  }
}

// URL input — live counter
const urlInput = document.getElementById('urlInput');

urlInput.addEventListener('input', () => {
  const count = countUrls(urlInput.value);
  document.getElementById('urlCount').textContent = `${count} URL${count !== 1 ? 's' : ''} detected`;
});

function extractLabelFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    const lastPart = path.split('/').filter(p => p).pop() || urlObj.hostname;
    return lastPart.replace(/[-_]/g, ' ').replace(/\.[^.]+$/, '');
  } catch {
    return 'Document';
  }
}

// Google Drive placeholder
function connectGoogleDrive() {
  showNotification('Google Drive integration coming soon', 'info');
}

// Update files list UI
function updateFilesList() {
  const container = document.getElementById('filesContainer');
  const fileCount = document.getElementById('fileCount');

  fileCount.textContent = `(${state.exhibits.length})`;

  if (state.exhibits.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No documents uploaded yet</p></div>';
    return;
  }

  container.innerHTML = '';

  state.exhibits.forEach(exhibit => {
    const icon = getFileIcon(exhibit.type);
    const meta = exhibit.type === 'url'
      ? escapeHtml(exhibit.url)
      : `${formatFileSize(exhibit.size)}${exhibit.type === 'image' ? ' (will be converted to PDF)' : ''}`;

    const item = document.createElement('div');
    item.className = 'file-item';
    item.innerHTML = `
      <span class="file-icon">${icon}</span>
      <div class="file-info">
        <div class="file-name">${escapeHtml(exhibit.label)}</div>
        <div class="file-meta">${meta}</div>
      </div>
      <button type="button" class="file-remove" onclick="removeExhibit('${exhibit.id}')">×</button>
    `;
    container.appendChild(item);
  });
}

function removeExhibit(id) {
  state.exhibits = state.exhibits.filter(e => e.id !== id);
  updateFilesList();
  updateContinueButton();
}

function updateContinueButton() {
  const btn = document.getElementById('toReviewBtn');
  btn.disabled = state.exhibits.length === 0;
}

// ============================================
// Stage 2: Review & Label
// ============================================

function renderReviewList() {
  const container = document.getElementById('reviewList');
  const visaType = document.getElementById('visaType').value;
  const numberingStyle = document.getElementById('numberingStyle').value;

  container.innerHTML = '';

  state.exhibits.forEach((exhibit, index) => {
    const exhibitNum = getExhibitNumber(index, numberingStyle);
    const item = document.createElement('div');
    item.className = 'review-item';
    item.dataset.id = exhibit.id;

    const sourceInfo = exhibit.type === 'url'
      ? escapeHtml(exhibit.url)
      : `${escapeHtml(exhibit.filename)}${exhibit.type === 'image' ? ' (image → PDF)' : ''}`;

    item.innerHTML = `
      <div class="review-number">${escapeHtml(exhibitNum)}</div>
      <div class="review-content">
        <div class="review-filename">${sourceInfo}</div>
        <input type="text" class="review-label-input" value="${escapeHtml(exhibit.label)}"
               onchange="updateExhibitLabel('${exhibit.id}', this.value)"
               placeholder="Enter exhibit label...">
        ${visaType ? `
        <div class="review-classification">
          <select onchange="updateExhibitClassification('${exhibit.id}', this.value)">
            <option value="">Select criteria...</option>
            ${getVisaCriteriaOptions(visaType, exhibit.classification)}
          </select>
          ${exhibit.confidence ? `
            <span class="confidence-badge ${getConfidenceClass(exhibit.confidence)}">
              ${Math.round(exhibit.confidence * 100)}% confident
            </span>
          ` : ''}
        </div>
        ` : ''}
      </div>
      <div class="review-actions-cell">
        <button type="button" class="btn btn-small" onclick="removeExhibit('${exhibit.id}'); renderReviewList();">Remove</button>
      </div>
    `;

    container.appendChild(item);
  });
}

function getVisaCriteriaOptions(visaType, selected) {
  const criteria = {
    'O-1A': [
      'Awards - Nationally/Internationally recognized prizes',
      'Membership - Associations requiring outstanding achievements',
      'Published Material - About the beneficiary in major media',
      'Judging - Judging the work of others',
      'Original Contributions - Of major significance',
      'Scholarly Articles - In professional journals',
      'Employment - In critical/essential capacity',
      'High Salary - Commanding high remuneration'
    ],
    'O-1B': [
      'Lead/Starring Role - In distinguished productions',
      'Critical Reviews - Recognition for achievements',
      'Lead Role for Organizations - With distinguished reputation',
      'Record of Commercial Success - High salary/box office',
      'Recognition - From organizations, critics, experts',
      'Original Contributions - To the field'
    ],
    'EB-1A': [
      'Awards - Lesser nationally/internationally recognized prizes',
      'Membership - Associations requiring outstanding achievements',
      'Published Material - About the beneficiary',
      'Judging - Judging the work of others',
      'Original Contributions - Of major significance',
      'Scholarly Articles - In professional journals',
      'Exhibitions - Display of work',
      'Leading Role - In distinguished organizations',
      'High Salary - Compared to others in field',
      'Commercial Success - In performing arts'
    ],
    'P-1A': [
      'International Recognition - As an athlete',
      'Team Participation - In international competition',
      'National/International Rankings',
      'Awards - Significant awards in sport',
      'Recognition - From sports organizations',
      'Media Coverage - Of athletic achievements'
    ]
  };

  const opts = criteria[visaType] || [];
  return opts.map(opt =>
    `<option value="${escapeHtml(opt)}" ${selected === opt ? 'selected' : ''}>${escapeHtml(opt)}</option>`
  ).join('');
}

function getConfidenceClass(confidence) {
  if (confidence >= 0.8) return 'confidence-high';
  if (confidence >= 0.5) return 'confidence-medium';
  return 'confidence-low';
}

function updateExhibitLabel(id, label) {
  const exhibit = state.exhibits.find(e => e.id === id);
  if (exhibit) {
    exhibit.label = label;
  }
}

function updateExhibitClassification(id, classification) {
  const exhibit = state.exhibits.find(e => e.id === id);
  if (exhibit) {
    exhibit.classification = classification;
  }
}

function autoNameFromFilename() {
  state.exhibits.forEach(exhibit => {
    if (exhibit.type === 'pdf' || exhibit.type === 'image') {
      exhibit.label = exhibit.filename
        .replace(/\.(pdf|jpe?g|png)$/i, '')
        .replace(/[-_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
  });
  renderReviewList();
  showNotification('Labels updated from filenames', 'success');
}

async function runAiClassification() {
  const visaType = document.getElementById('visaType').value;
  if (!visaType) {
    showNotification('Please select a visa type first', 'error');
    return;
  }

  // Only classify PDF exhibits (images and URLs would need conversion first)
  const pdfExhibits = state.exhibits.filter(e => e.type === 'pdf' && e.file);
  if (pdfExhibits.length === 0) {
    showNotification('No uploaded PDF files to classify. AI classification works on PDF files only.', 'error');
    return;
  }

  const aiBtn = document.getElementById('aiClassifyBtn');
  aiBtn.disabled = true;
  aiBtn.innerHTML = '<span>⏳</span> Classifying...';

  showNotification(`Analyzing ${pdfExhibits.length} documents with AI...`, 'info');

  try {
    // Prepare form data with PDFs and labels
    const formData = new FormData();
    formData.append('visaType', visaType);

    const labels = {};
    pdfExhibits.forEach(exhibit => {
      formData.append('files', exhibit.file, exhibit.filename);
      labels[exhibit.filename] = exhibit.label;
    });
    formData.append('labels', JSON.stringify(labels));

    // Call classification API
    const response = await fetch('/api/pdf/classify', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Classification failed');
    }

    const result = await response.json();

    // Update exhibits with classification results
    if (result.classifications) {
      for (const classification of result.classifications) {
        const exhibit = pdfExhibits.find(e =>
          e.filename === classification.originalLabel ||
          e.label === classification.originalLabel
        );

        if (exhibit && classification.success) {
          exhibit.classification = classification.criterion_name || null;
          exhibit.confidence = classification.confidence || null;

          if (classification.suggested_label && classification.suggested_label !== exhibit.label) {
            exhibit.aiSuggestedLabel = classification.suggested_label;
          }
        }
      }
    }

    // Show analysis results
    if (result.analysis) {
      const { criteriaAnalysis, recommendation } = result.analysis;
      const strongCount = criteriaAnalysis.strong?.length || 0;
      const weakCount = criteriaAnalysis.weak?.length || 0;
      const missingCount = criteriaAnalysis.missing?.length || 0;

      showNotification(
        `Analysis complete: ${strongCount} strong, ${weakCount} need more evidence, ${missingCount} missing criteria`,
        recommendation.status === 'ready' ? 'success' : 'info'
      );
    } else {
      showNotification('Classification complete!', 'success');
    }

    renderReviewList();

  } catch (error) {
    console.error('AI classification error:', error);
    showNotification(`Classification failed: ${error.message}`, 'error');
  } finally {
    aiBtn.disabled = false;
    aiBtn.innerHTML = '<span>🤖</span> Run AI Classification';
  }
}

// ============================================
// Stage 3: Reorder
// ============================================

function renderReorderList() {
  const container = document.getElementById('reorderList');
  const numberingStyle = document.getElementById('numberingStyle').value;

  container.innerHTML = '';

  state.exhibits.forEach((exhibit, index) => {
    const exhibitNum = getExhibitNumber(index, numberingStyle);
    const icon = getFileIcon(exhibit.type);
    const sourceLabel = exhibit.type === 'image' ? '🖼️ Image' : (exhibit.type === 'pdf' ? '📄 PDF' : '🔗 URL');

    const item = document.createElement('div');
    item.className = 'reorder-item';
    item.dataset.id = exhibit.id;

    item.innerHTML = `
      <span class="drag-handle">☰</span>
      <span class="reorder-number">Exhibit ${escapeHtml(exhibitNum)}</span>
      <span class="reorder-label">${escapeHtml(exhibit.label)}</span>
      <span class="reorder-source">${sourceLabel}</span>
    `;

    container.appendChild(item);
  });

  // Initialize SortableJS
  if (state.sortableInstance) {
    state.sortableInstance.destroy();
  }

  state.sortableInstance = new Sortable(container, {
    animation: 150,
    handle: '.drag-handle',
    ghostClass: 'sortable-ghost',
    dragClass: 'sortable-drag',
    onEnd: function(evt) {
      state.orderHistory.push([...state.exhibits]);
      if (state.orderHistory.length > 10) {
        state.orderHistory.shift();
      }
      document.getElementById('undoBtn').disabled = false;

      const movedItem = state.exhibits.splice(evt.oldIndex, 1)[0];
      state.exhibits.splice(evt.newIndex, 0, movedItem);

      renderReorderList();
    }
  });
}

function sortAlphabetically() {
  state.orderHistory.push([...state.exhibits]);
  state.exhibits.sort((a, b) => a.label.localeCompare(b.label));
  renderReorderList();
  document.getElementById('undoBtn').disabled = false;
}

function sortByType() {
  state.orderHistory.push([...state.exhibits]);
  state.exhibits.sort((a, b) => {
    if (a.classification && b.classification) {
      return a.classification.localeCompare(b.classification);
    }
    return a.type.localeCompare(b.type);
  });
  renderReorderList();
  document.getElementById('undoBtn').disabled = false;
}

function reverseOrder() {
  state.orderHistory.push([...state.exhibits]);
  state.exhibits.reverse();
  renderReorderList();
  document.getElementById('undoBtn').disabled = false;
}

function undoReorder() {
  if (state.orderHistory.length === 0) return;
  state.exhibits = state.orderHistory.pop();
  renderReorderList();
  if (state.orderHistory.length === 0) {
    document.getElementById('undoBtn').disabled = true;
  }
}

// ============================================
// Stage 4: Generate
// ============================================

function updateGenerateSummary() {
  const numberingStyle = document.getElementById('numberingStyle').value;
  const visaType = document.getElementById('visaType').value;
  const deliveryMethod = document.getElementById('deliveryMethod').value;

  document.getElementById('summaryCount').textContent = state.exhibits.length;
  document.getElementById('summaryVisaType').textContent = visaType || 'Not selected';
  document.getElementById('summaryNumbering').textContent =
    numberingStyle === 'letters' ? 'Letters (A, B, C...)' :
    numberingStyle === 'numbers' ? 'Numbers (1, 2, 3...)' :
    'Roman (I, II, III...)';
  document.getElementById('summaryDelivery').textContent =
    deliveryMethod === 'download' ? 'Download' :
    deliveryMethod === 'drive' ? 'Google Drive' : 'Email';

  // Render preview
  const preview = document.getElementById('exhibitPreview');
  preview.innerHTML = '';

  state.exhibits.forEach((exhibit, index) => {
    const exhibitNum = getExhibitNumber(index, numberingStyle);
    const item = document.createElement('div');
    item.className = 'preview-item';
    item.innerHTML = `
      <span class="preview-number">Exhibit ${escapeHtml(exhibitNum)}</span>
      <span class="preview-label">${escapeHtml(exhibit.label)}</span>
    `;
    preview.appendChild(item);
  });
}

async function generatePackage() {
  const generateBtn = document.getElementById('generateBtn');
  const progressSection = document.getElementById('generateProgress');

  generateBtn.disabled = true;
  progressSection.classList.remove('hidden');

  try {
    // Prepare form data
    const formData = new FormData();

    // Add configuration
    formData.append('config', JSON.stringify({
      visaType: document.getElementById('visaType').value,
      numberingStyle: document.getElementById('numberingStyle').value,
      beneficiaryName: document.getElementById('beneficiaryName').value,
      petitionerName: document.getElementById('petitionerName').value,
      caseName: document.getElementById('caseName').value,
      enableCompression: document.getElementById('enableCompression').checked,
      enableToc: document.getElementById('enableToc').checked,
      enableCoverPages: document.getElementById('enableCoverPages').checked,
      deliveryMethod: document.getElementById('deliveryMethod').value,
      recipientEmail: document.getElementById('recipientEmail').value
    }));

    // Add exhibits metadata
    const exhibitsData = state.exhibits.map((exhibit, index) => ({
      id: exhibit.id,
      type: exhibit.type,  // 'pdf', 'image', or 'url'
      url: exhibit.url,
      label: exhibit.label,
      filename: exhibit.filename,
      classification: exhibit.classification,
      order: index
    }));
    formData.append('exhibits', JSON.stringify(exhibitsData));

    // Add files (both PDFs and images)
    state.exhibits.forEach(exhibit => {
      if ((exhibit.type === 'pdf' || exhibit.type === 'image') && exhibit.file) {
        formData.append('files', exhibit.file, exhibit.id + getFileExtension(exhibit.filename));
      }
    });

    // Send to API
    updateProgress(5, 'Uploading files...');

    const response = await fetch('/api/pdf/generate', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to start generation');
    }

    const result = await response.json();

    // Poll for status
    await pollGenerationStatus(result.jobId);

  } catch (error) {
    showNotification(error.message, 'error');
    generateBtn.disabled = false;
    progressSection.classList.add('hidden');
  }
}

async function pollGenerationStatus(jobId) {
  const maxAttempts = 300;
  let attempts = 0;

  const poll = async () => {
    try {
      const response = await fetch(`/api/pdf/status/${jobId}`);
      if (!response.ok) throw new Error('Failed to check status');

      const job = await response.json();

      updateProgress(job.progress, job.statusMessage || 'Processing...');
      addProgressLog(job.logs);

      if (job.status === 'completed') {
        state.packageResult = job;
        goToStage(5);
        showComplete(job);
      } else if (job.status === 'failed') {
        throw new Error(job.error || 'Generation failed');
      } else if (attempts < maxAttempts) {
        attempts++;
        setTimeout(poll, 2000);
      } else {
        throw new Error('Generation timed out');
      }
    } catch (error) {
      showNotification(error.message, 'error');
      document.getElementById('generateBtn').disabled = false;
      document.getElementById('generateProgress').classList.add('hidden');
    }
  };

  poll();
}

function updateProgress(percent, status) {
  document.getElementById('progressFill').style.width = `${percent}%`;
  document.getElementById('progressPercent').textContent = `${percent}%`;
  document.getElementById('progressStatus').textContent = status;
}

function addProgressLog(logs) {
  if (!logs || !Array.isArray(logs)) return;

  const container = document.getElementById('progressLog');
  container.innerHTML = '';

  logs.forEach(log => {
    const entry = document.createElement('div');
    entry.className = `log-entry ${log.type || ''}`;
    entry.textContent = `[${new Date(log.time).toLocaleTimeString()}] ${log.message}`;
    container.appendChild(entry);
  });

  container.scrollTop = container.scrollHeight;
}

// ============================================
// Stage 5: Complete
// ============================================

function showComplete(job) {
  document.getElementById('completeExhibits').textContent = state.exhibits.length;
  document.getElementById('completePages').textContent = job.totalPages || '?';
  document.getElementById('completeSize').textContent = formatFileSize(job.packageSize || 0);

  const deliveryResult = document.getElementById('deliveryResult');
  const deliveryMethod = document.getElementById('deliveryMethod').value;

  if (deliveryMethod === 'download') {
    deliveryResult.innerHTML = `
      <p><strong>Your package is ready for download!</strong></p>
      <p>Click the button below to download your exhibit package.</p>
    `;
  } else if (deliveryMethod === 'drive' && job.driveLink) {
    deliveryResult.innerHTML = `
      <p><strong>Uploaded to Google Drive!</strong></p>
      <p>Your exhibit package has been shared to ${escapeHtml(job.recipientEmail)}</p>
      <a href="${escapeHtml(job.driveLink)}" target="_blank" class="btn btn-primary" style="margin-top: 10px;">
        Open in Google Drive
      </a>
    `;
  } else if (deliveryMethod === 'email') {
    deliveryResult.innerHTML = `
      <p><strong>Email Sent!</strong></p>
      <p>Your exhibit package has been emailed to ${escapeHtml(job.recipientEmail)}</p>
      <p style="color: var(--gray-500);">Check your inbox (and spam folder)</p>
    `;
  }

  const downloadBtn = document.getElementById('downloadBtn');
  if (job.downloadUrl) {
    downloadBtn.onclick = () => window.open(job.downloadUrl, '_blank');
    downloadBtn.style.display = 'inline-flex';
  } else {
    downloadBtn.style.display = 'none';
  }
}

function downloadPackage() {
  if (state.packageResult && state.packageResult.downloadUrl) {
    window.open(state.packageResult.downloadUrl, '_blank');
  }
}

function startNewCase() {
  state.exhibits = [];
  state.orderHistory = [];
  state.packageResult = null;
  state.currentStage = 1;

  document.getElementById('visaType').value = '';
  document.getElementById('numberingStyle').value = 'letters';
  document.getElementById('beneficiaryName').value = '';
  document.getElementById('petitionerName').value = '';
  document.getElementById('caseName').value = '';
  document.getElementById('deliveryMethod').value = 'download';
  document.getElementById('recipientEmail').value = '';
  document.getElementById('urlInput').value = '';

  updateFilesList();
  document.getElementById('generateProgress').classList.add('hidden');
  document.getElementById('generateBtn').disabled = false;

  goToStage(1);
  showNotification('Ready for new case', 'info');
}

// ============================================
// Sidebar Events
// ============================================

document.getElementById('deliveryMethod').addEventListener('change', (e) => {
  const emailGroup = document.getElementById('emailGroup');
  emailGroup.style.display = e.target.value === 'email' || e.target.value === 'drive' ? 'block' : 'none';
});

document.getElementById('visaType').addEventListener('change', () => {
  if (state.currentStage === 2) {
    renderReviewList();
  }
});

document.getElementById('numberingStyle').addEventListener('change', () => {
  if (state.currentStage === 2) {
    renderReviewList();
  } else if (state.currentStage === 3) {
    renderReorderList();
  } else if (state.currentStage === 4) {
    updateGenerateSummary();
  }
});

// ============================================
// Keyboard Shortcuts
// ============================================

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (state.currentStage < 5 && state.exhibits.length > 0) {
      goToStage(state.currentStage + 1);
    }
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 'z' && state.currentStage === 3) {
    undoReorder();
  }
});

// ============================================
// Service Configuration Check
// ============================================

let serviceConfig = null;

async function checkServiceConfig() {
  try {
    const response = await fetch('/api/pdf/config-status');
    if (response.ok) {
      serviceConfig = await response.json();

      if (!serviceConfig.urlConversion) {
        const urlTab = document.querySelector('[data-upload-tab="url"]');
        if (urlTab) {
          urlTab.innerHTML += ' <span style="color: var(--warning);" title="URL conversion unavailable">⚠️</span>';
        }

        const urlUploadSection = document.getElementById('upload-url');
        if (urlUploadSection) {
          const warning = document.createElement('div');
          warning.className = 'notification warning';
          warning.style.marginBottom = '16px';
          warning.innerHTML = '<strong>⚠️ URL Conversion Unavailable:</strong> The server is not configured for URL-to-PDF conversion. Please upload PDFs directly or contact the administrator.';
          urlUploadSection.prepend(warning);
        }
      }

      if (!serviceConfig.email) {
        const emailOption = document.querySelector('#deliveryMethod option[value="email"]');
        if (emailOption) {
          emailOption.textContent += ' (unavailable)';
          emailOption.disabled = true;
        }
      }

      if (!serviceConfig.googleDrive) {
        const driveOption = document.querySelector('#deliveryMethod option[value="drive"]');
        if (driveOption) {
          driveOption.textContent += ' (unavailable)';
          driveOption.disabled = true;
        }
      }
    }
  } catch (error) {
    console.warn('Could not check service config:', error);
  }
}

// ============================================
// Initialize
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  updateFilesList();
  updateContinueButton();
  checkServiceConfig();
});