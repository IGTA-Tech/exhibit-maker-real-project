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
    return url.startsWith('http://') || url.startsWith('https://');
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
  if (!['txt', 'csv', 'json'].includes(ext)) {
    alert('Please upload a .txt, .csv, or .json file');
    return;
  }

  fileInfo.innerHTML = `
    <span style="font-size: 1.5rem;">📄</span>
    <div>
      <strong>${file.name}</strong>
      <div style="font-size: 0.875rem; color: var(--text-light);">
        ${(file.size / 1024).toFixed(1)} KB
      </div>
    </div>
    <button type="button" class="btn btn-secondary" onclick="clearFile()" style="margin-left: auto; padding: 6px 12px;">Remove</button>
  `;
  fileInfo.classList.remove('hidden');

  // Read file to count URLs
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

// Form submission
convertForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const formData = new FormData();
  const deliveryMethod = document.querySelector('input[name="deliveryMethod"]:checked').value;
  const recipientEmail = document.getElementById('recipientEmail').value;
  const folderName = document.getElementById('folderName').value;

  // Validate
  if (!recipientEmail) {
    alert('Please enter a recipient email');
    return;
  }

  // Check if we have URLs
  const urlText = urlTextarea.value.trim();
  const hasFile = urlFileInput.files.length > 0;

  if (!urlText && !hasFile) {
    alert('Please enter URLs or upload a file');
    return;
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

  try {
    // Start conversion
    const response = await fetch('/api/pdf/convert', {
      method: 'POST',
      body: formData
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Conversion failed');
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
        showError('Conversion timed out');
      }
    } catch (error) {
      showError(error.message);
    }
  };

  poll();
}

// Update progress UI
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

  document.getElementById('statTotal').textContent = job.totalUrls;
  document.getElementById('statSuccess').textContent = job.successCount;
  document.getElementById('statFailed').textContent = job.failedCount;

  // Update log
  const logContent = document.getElementById('logContent');
  logContent.innerHTML = job.logs.map(log => `
    <div class="log-entry">
      <span class="log-time">[${new Date(log.time).toLocaleTimeString()}]</span>
      ${log.message}
    </div>
  `).join('');
  logContent.scrollTop = logContent.scrollHeight;
}

// Show success result
function showSuccess(job) {
  convertBtn.disabled = false;
  convertBtn.textContent = 'Start Conversion';

  resultSection.classList.remove('hidden');

  let resultHtml = `
    <div class="result-success">
      <div class="result-icon">✅</div>
      <h2>Conversion Complete!</h2>
      <p style="color: var(--text-light); margin: 10px 0;">
        Successfully converted ${job.successCount} of ${job.totalUrls} URLs
      </p>
  `;

  if (job.deliveryResult.method === 'Google Drive') {
    resultHtml += `
      <p style="margin: 20px 0;">Your PDFs have been shared to <strong>${job.recipientEmail}</strong></p>
      <a href="${job.deliveryResult.shareLink}" target="_blank" class="result-link">
        Open Google Drive Folder
      </a>
    `;
  } else {
    resultHtml += `
      <p style="margin: 20px 0;">
        An email with your PDFs has been sent to <strong>${job.recipientEmail}</strong>
      </p>
      <div style="color: var(--text-light);">Check your inbox (and spam folder)</div>
    `;
  }

  resultHtml += '</div>';
  document.getElementById('resultContent').innerHTML = resultHtml;
}

// Show error
function showError(message) {
  convertBtn.disabled = false;
  convertBtn.textContent = 'Start Conversion';

  resultSection.classList.remove('hidden');
  document.getElementById('resultContent').innerHTML = `
    <div class="result-error">
      <div class="result-icon">❌</div>
      <h2>Something went wrong</h2>
      <p style="color: var(--error); margin: 10px 0;">${message}</p>
    </div>
  `;
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
}
