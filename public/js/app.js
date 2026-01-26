// DOM Elements
const convertForm = document.getElementById('convertForm');
const urlTextarea = document.getElementById('urlText');
const urlFileInput = document.getElementById('urlFile');
const fileDrop = document.getElementById('fileDrop');
const fileInfo = document.getElementById('fileInfo');
const urlCount = document.getElementById('urlCount');
const convertBtn = document.getElementById('convertBtn');
const progressSection = document.getElementById('progressSection');
const resultSection = document.getElementById('resultSection');

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  if (typeof text !== 'string') return String(text);
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Validate email format
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
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

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    tab.classList.add('active');
    document.getElementById(`${tab.dataset.tab}-content`).classList.add('active');
  });
});

// URL counting
urlTextarea.addEventListener('input', () => {
  const urls = countUrls(urlTextarea.value);
  urlCount.textContent = urls;
});

function countUrls(text) {
  const lines = text.split(/[\r\n]+/).filter(line => {
    const url = line.split(',')[0].trim();
    return isValidUrl(url);
  });
  return lines.length;
}

// File drag and drop
fileDrop.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileDrop.classList.add('drag-over');
});

fileDrop.addEventListener('dragleave', () => {
  fileDrop.classList.remove('drag-over');
});

fileDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDrop.classList.remove('drag-over');

  const file = e.dataTransfer.files[0];
  if (file) {
    handleFileSelect(file);
  }
});

urlFileInput.addEventListener('change', (e) => {
  if (e.target.files[0]) {
    handleFileSelect(e.target.files[0]);
  }
});

function handleFileSelect(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['txt', 'csv', 'json', 'zip'].includes(ext)) {
    showNotification('Please upload a .txt, .csv, .json, or .zip file', 'error');
    return;
  }

  // Sanitize filename for display
  const safeName = escapeHtml(file.name);

  fileInfo.innerHTML = `
    <span style="font-size: 1.5rem;">📄</span>
    <div>
      <strong>${safeName}</strong>
      <div style="font-size: 0.875rem; color: var(--text-light);">
        ${(file.size / 1024).toFixed(1)} KB
      </div>
    </div>
    <button type="button" class="btn btn-secondary" onclick="clearFile()" style="margin-left: auto; padding: 6px 12px;">Remove</button>
  `;
  fileInfo.classList.remove('hidden');

  // Read file to count URLs (skip for ZIP files)
  if (ext === 'zip') {
    fileInfo.querySelector('div').innerHTML += `<div style="color: var(--primary); font-weight: 500;">ZIP file selected</div>`;
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    const content = e.target.result;
    let count = 0;

    if (ext === 'json') {
      try {
        const data = JSON.parse(content);
        count = Array.isArray(data) ? data.length : 0;
      } catch (err) {
        count = 0;
      }
    } else {
      count = countUrls(content);
    }

    fileInfo.querySelector('div').innerHTML += `<div style="color: var(--primary); font-weight: 500;">${count} URLs detected</div>`;
  };
  reader.readAsText(file);
}

function clearFile() {
  urlFileInput.value = '';
  fileInfo.classList.add('hidden');
}

// Show notification
function showNotification(message, type = 'info') {
  // Remove existing notification
  const existing = document.querySelector('.notification');
  if (existing) {
    existing.remove();
  }

  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.textContent = message;
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 12px 20px;
    border-radius: 8px;
    background: ${type === 'error' ? '#dc2626' : type === 'success' ? '#16a34a' : '#2563eb'};
    color: white;
    font-weight: 500;
    z-index: 1000;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    animation: slideIn 0.3s ease;
  `;

  document.body.appendChild(notification);

  setTimeout(() => {
    notification.remove();
  }, 5000);
}

// Form submission
convertForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const formData = new FormData();
  const deliveryMethod = document.querySelector('input[name="deliveryMethod"]:checked').value;
  const recipientEmail = document.getElementById('recipientEmail').value.trim();
  const folderName = document.getElementById('folderName').value.trim();

  // Validate email
  if (!recipientEmail) {
    showNotification('Please enter a recipient email', 'error');
    document.getElementById('recipientEmail').focus();
    return;
  }

  if (!isValidEmail(recipientEmail)) {
    showNotification('Please enter a valid email address', 'error');
    document.getElementById('recipientEmail').focus();
    return;
  }

  // Check if we have URLs
  const urlText = urlTextarea.value.trim();
  const hasFile = urlFileInput.files.length > 0;

  if (!urlText && !hasFile) {
    showNotification('Please enter URLs or upload a file', 'error');
    return;
  }

  // Validate URLs in text input
  if (urlText && !hasFile) {
    const urlLines = urlText.split(/[\r\n]+/).filter(line => line.trim());
    const invalidUrls = urlLines.filter(line => {
      const url = line.split(',')[0].trim();
      return url && !isValidUrl(url);
    });

    if (invalidUrls.length > 0 && invalidUrls.length === urlLines.length) {
      showNotification('No valid URLs found. URLs must start with http:// or https://', 'error');
      return;
    }
  }

  // Prepare request
  if (hasFile) {
    formData.append('urlFile', urlFileInput.files[0]);
  } else {
    formData.append('urlText', urlText);
  }

  formData.append('deliveryMethod', deliveryMethod);
  formData.append('recipientEmail', recipientEmail);
  if (folderName) {
    formData.append('folderName', folderName);
  }

  // Show progress section
  convertBtn.disabled = true;
  convertBtn.textContent = 'Starting...';
  progressSection.classList.remove('hidden');
  resultSection.classList.add('hidden');

  // Scroll to progress section
  progressSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    // Start conversion
    const response = await fetch('/api/pdf/convert', {
      method: 'POST',
      body: formData
    });

    const result = await response.json();

    if (!response.ok) {
      const errorMsg = result.details
        ? result.details.join(', ')
        : (result.error || 'Conversion failed');
      throw new Error(errorMsg);
    }

    // Poll for status
    pollJobStatus(result.jobId);

  } catch (error) {
    showError(error.message);
    convertBtn.disabled = false;
    convertBtn.textContent = 'Start Conversion';
  }
});

// Poll job status
async function pollJobStatus(jobId) {
  const pollInterval = 2000; // 2 seconds
  const maxAttempts = 300; // 10 minutes max
  let attempts = 0;

  const poll = async () => {
    try {
      const response = await fetch(`/api/pdf/status/${jobId}`);

      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('Job not found. It may have expired.');
        }
        throw new Error('Failed to check job status');
      }

      const job = await response.json();

      updateProgress(job);

      if (job.status === 'completed') {
        showSuccess(job);
      } else if (job.status === 'failed') {
        showError(job.error || 'Conversion failed');
      } else if (attempts < maxAttempts) {
        attempts++;
        setTimeout(poll, pollInterval);
      } else {
        showError('Conversion timed out. Please try again.');
      }
    } catch (error) {
      if (error.message.includes('NetworkError') || error.message.includes('Failed to fetch')) {
        // Network error - retry a few times
        if (attempts < 3) {
          attempts++;
          setTimeout(poll, pollInterval * 2);
          return;
        }
        showError('Network error. Please check your connection and try again.');
      } else {
        showError(error.message);
      }
    }
  };

  poll();
}

// Update progress UI with XSS protection
function updateProgress(job) {
  document.getElementById('progressFill').style.width = `${job.progress}%`;
  document.getElementById('progressPercent').textContent = `${job.progress}%`;

  const statusMap = {
    processing: 'Converting URLs to PDFs...',
    uploading: 'Uploading to Google Drive...',
    sending: 'Sending email...',
    completed: 'Complete!',
    failed: 'Failed'
  };
  document.getElementById('progressStatus').textContent = statusMap[job.status] || job.status;

  document.getElementById('statTotal').textContent = job.totalUrls || 0;
  document.getElementById('statSuccess').textContent = job.successCount || 0;
  document.getElementById('statFailed').textContent = job.failedCount || 0;

  // Update log with XSS protection
  const logContent = document.getElementById('logContent');
  logContent.innerHTML = '';

  if (job.logs && Array.isArray(job.logs)) {
    job.logs.forEach(log => {
      const entry = document.createElement('div');
      entry.className = 'log-entry';

      const timeSpan = document.createElement('span');
      timeSpan.className = 'log-time';
      timeSpan.textContent = `[${new Date(log.time).toLocaleTimeString()}]`;

      const msgSpan = document.createElement('span');
      msgSpan.textContent = ' ' + log.message; // Safe - textContent escapes HTML

      entry.appendChild(timeSpan);
      entry.appendChild(msgSpan);
      logContent.appendChild(entry);
    });
  }

  logContent.scrollTop = logContent.scrollHeight;
}

// Show success result with XSS protection
function showSuccess(job) {
  convertBtn.disabled = false;
  convertBtn.textContent = 'Start Conversion';

  resultSection.classList.remove('hidden');

  const resultContent = document.getElementById('resultContent');
  resultContent.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'result-success';

  const icon = document.createElement('div');
  icon.className = 'result-icon';
  icon.textContent = '✅';

  const title = document.createElement('h2');
  title.textContent = 'Conversion Complete!';

  const stats = document.createElement('p');
  stats.style.cssText = 'color: var(--text-light); margin: 10px 0;';
  stats.textContent = `Successfully converted ${job.successCount || 0} of ${job.totalUrls || 0} URLs`;

  container.appendChild(icon);
  container.appendChild(title);
  container.appendChild(stats);

  if (job.deliveryResult && job.deliveryResult.method === 'Google Drive') {
    const msg = document.createElement('p');
    msg.style.margin = '20px 0';
    msg.innerHTML = `Your PDFs have been shared to <strong>${escapeHtml(job.recipientEmail)}</strong>`;

    const link = document.createElement('a');
    link.href = job.deliveryResult.shareLink;
    link.target = '_blank';
    link.className = 'result-link';
    link.textContent = 'Open Google Drive Folder';

    container.appendChild(msg);
    container.appendChild(link);
  } else {
    const msg = document.createElement('p');
    msg.style.margin = '20px 0';
    msg.innerHTML = `An email with your PDFs has been sent to <strong>${escapeHtml(job.recipientEmail)}</strong>`;

    const hint = document.createElement('div');
    hint.style.color = 'var(--text-light)';
    hint.textContent = 'Check your inbox (and spam folder)';

    container.appendChild(msg);
    container.appendChild(hint);
  }

  resultContent.appendChild(container);

  // Scroll to results
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Show error with XSS protection
function showError(message) {
  convertBtn.disabled = false;
  convertBtn.textContent = 'Start Conversion';

  resultSection.classList.remove('hidden');

  const resultContent = document.getElementById('resultContent');
  resultContent.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'result-error';

  const icon = document.createElement('div');
  icon.className = 'result-icon';
  icon.textContent = '❌';

  const title = document.createElement('h2');
  title.textContent = 'Something went wrong';

  const errorMsg = document.createElement('p');
  errorMsg.style.cssText = 'color: var(--error); margin: 10px 0;';
  errorMsg.textContent = message; // Safe - textContent escapes HTML

  container.appendChild(icon);
  container.appendChild(title);
  container.appendChild(errorMsg);

  resultContent.appendChild(container);

  // Scroll to results
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Reset form
function resetForm() {
  convertForm.reset();
  urlCount.textContent = '0';
  clearFile();
  progressSection.classList.add('hidden');
  resultSection.classList.add('hidden');

  // Reset progress
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('progressPercent').textContent = '0%';
  document.getElementById('progressStatus').textContent = 'Initializing...';
  document.getElementById('logContent').innerHTML = '';
  document.getElementById('statTotal').textContent = '0';
  document.getElementById('statSuccess').textContent = '0';
  document.getElementById('statFailed').textContent = '0';

  // Scroll to top
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// Add keyboard shortcut for form submission
document.addEventListener('keydown', (e) => {
  // Ctrl/Cmd + Enter to submit
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    if (!convertBtn.disabled) {
      convertForm.dispatchEvent(new Event('submit'));
    }
  }
});
