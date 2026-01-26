# Exhibit Maker - Developer Task List

## Project Overview

**Repository:** https://github.com/IGTA-Tech/exhibit-maker-real-project
**Production URL:** https://exhibit-maker-production.up.railway.app
**Railway Project:** exhibit-maker

This is a visa petition exhibit package generator that:
1. Accepts PDF uploads or URLs
2. Converts URLs to PDFs
3. Adds exhibit cover pages (Exhibit A, B, C...)
4. Generates Table of Contents
5. Merges into single package
6. Delivers via Download, Email, or Google Drive

---

## CRITICAL ISSUES TO FIX

### 1. URL-to-PDF Conversion Not Working (HIGH PRIORITY)

**Current State:** The "From URLs" feature in the UI does not work reliably.

**Root Cause Analysis:**
- Currently uses api2pdf.com service ($15/month, has rate limits)
- API key IS configured on Railway: `8c1f0773-28dd-42b4-8447-a511876fd223`
- api2pdf has strict rate limits (varies by plan)
- Service can be slow and unreliable

**SOLUTION: Replace api2pdf with Puppeteer (self-hosted, free, no limits)**

```javascript
// Current (api2pdf) - REPLACE THIS
const result = await convertUrlToPdfWithRetry(url, fileName);

// New (Puppeteer) - IMPLEMENT THIS
const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.goto(url, { waitUntil: 'networkidle0' });
const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
await browser.close();
```

**Files to Modify:**
- `src/services/pdfService.js` - Replace api2pdf with Puppeteer
- `package.json` - Add `puppeteer` dependency
- `Dockerfile` - Add Chromium dependencies for Railway

**Puppeteer Dockerfile additions needed:**
```dockerfile
# Install Chromium dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
```

---

### 2. PDF Compression Needed (HIGH PRIORITY)

**Current State:** Generated packages are too large (50-70MB), causing:
- Email delivery failures (SendGrid 20MB limit)
- Slow downloads
- Storage issues

**SOLUTION: Implement PDF compression using Ghostscript or pdf-lib**

**Option A: Ghostscript (best compression)**
```javascript
const { exec } = require('child_process');

async function compressPdf(inputPath, outputPath, quality = 'ebook') {
  // quality options: screen (72dpi), ebook (150dpi), printer (300dpi)
  return new Promise((resolve, reject) => {
    exec(`gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/${quality} -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputPath}" "${inputPath}"`,
      (error) => error ? reject(error) : resolve(outputPath)
    );
  });
}
```

**Option B: pdf-lib (JavaScript only, moderate compression)**
```javascript
const { PDFDocument } = require('pdf-lib');

async function compressPdf(inputBuffer) {
  const pdfDoc = await PDFDocument.load(inputBuffer);
  // Remove metadata, flatten forms, etc.
  const compressedBytes = await pdfDoc.save({
    useObjectStreams: true,
    addDefaultPage: false,
  });
  return compressedBytes;
}
```

**Dockerfile for Ghostscript:**
```dockerfile
RUN apt-get update && apt-get install -y ghostscript
```

**Files to Modify:**
- `src/services/exhibitService.js` - Add compression after merge
- `src/routes/pdf.js` - Add compression option to config
- `public/js/app.js` - Add compression quality selector

---

### 3. Google Drive Upload Issues

**Current State:** Google Drive integration may not be working correctly.

**Verification Steps:**
1. Check if service account has correct permissions
2. Verify folder sharing works
3. Test file upload to Drive

**Files to Check:**
- `src/services/googleDriveService.js`

---

### 4. Large File Email Delivery

**Current State:** SendGrid has 20MB attachment limit. Large packages fail to send.

**SOLUTION: Split large packages or use download links**

```javascript
async function sendPackage(pdfPath, email) {
  const stats = fs.statSync(pdfPath);

  if (stats.size > 15 * 1024 * 1024) { // 15MB threshold
    // Upload to Supabase storage and send download link
    const downloadUrl = await uploadToSupabase(pdfPath);
    await sendEmailWithLink(email, downloadUrl);
  } else {
    // Direct attachment
    await sendEmailWithAttachment(email, pdfPath);
  }
}
```

---

## ENVIRONMENT VARIABLES (All Set on Railway)

| Variable | Status | Value (partial) |
|----------|--------|-----------------|
| API2PDF_API_KEY | Set | 8c1f0773-... |
| ANTHROPIC_API_KEY | Set | sk-ant-... |
| SUPABASE_URL | Set | https://izkoyvrfgswmhgstrmpj.supabase.co |
| SUPABASE_ANON_KEY | Set | eyJhbG... |
| SUPABASE_SERVICE_KEY | Set | eyJhbG... |
| GOOGLE_CREDENTIALS_BASE64 | Set | ewogIC... |
| EMAIL_HOST | Set | smtp.sendgrid.net |
| EMAIL_USER | Set | apikey |
| EMAIL_PASSWORD | Set | SG.tjh5... |
| EMAIL_FROM | Set | noreply@xtraordinarypetitions.com |

---

## TESTING RESULTS (From Automated Tests)

**40 Tests Run:** 29 Passed, 11 Failed

### Passed Tests:
- Health endpoint
- Homepage serving
- Input validation
- Security headers (helmet)
- CORS configuration
- XSS/SQL injection protection
- Rate limiting (but too aggressive)

### Failed Tests:
- `/api/pdf/generate-exhibits` - 404 (NOW FIXED in pending commit)
- `/api/pdf/jobs/:id` - 404 (NOW FIXED in pending commit)
- Rate limiting too aggressive - (NOW FIXED, increased to 100/hr)
- URL conversion - Not tested due to rate limits

---

## PENDING CODE CHANGES (Need to Commit & Push)

The following fixes have been made locally but NOT pushed to GitHub:

### 1. Rate Limiting Fixed
- `src/server.js` - Increased from 20 to 100/hour, configurable via env

### 2. Missing Endpoints Added
- `src/routes/pdf.js`:
  - `GET /api/pdf/jobs/:jobId` - Alias for status endpoint
  - `POST /api/pdf/generate-exhibits` - URL-only workflow
  - `GET /api/pdf/config-status` - Service configuration check

### 3. Better Error Handling
- `src/services/pdfService.js` - API key check, startup logging
- `src/routes/pdf.js` - Better error messages when API unavailable

### 4. Frontend Warnings
- `public/js/app.js` - Checks config status, warns if features unavailable

**To push these changes:**
```bash
cd C:\Users\IGTA\exhibit-maker-real-project
git add -A
git commit -m "Fix rate limiting, add missing endpoints, improve error handling"
git push origin main
```

---

## IMPLEMENTATION PRIORITY

### Phase 1: Critical Fixes (Do First)
1. Push pending code changes to GitHub
2. Replace api2pdf with Puppeteer for URL conversion
3. Add PDF compression (Ghostscript preferred)
4. Test URL-to-PDF workflow end-to-end

### Phase 2: Reliability Improvements
1. Add download link fallback for large files (>15MB)
2. Fix Google Drive integration if broken
3. Add better progress reporting for long conversions
4. Add job retry mechanism for failed conversions

### Phase 3: Nice to Have
1. Add drag-and-drop reordering preview
2. ZIP file upload support
3. Batch URL processing with progress bar
4. Archive.org URL backup before conversion

---

## REFERENCE CODE

The mega-visa-petition-generator project uses Puppeteer successfully. Reference implementation:

**File:** `mega-visa-petition-generator-v4/src/services/exhibitService.js`

Key patterns to copy:
- Puppeteer launch configuration for cloud deployment
- PDF generation with proper page settings
- Error handling for failed page loads
- Memory management (closing browsers)

---

## DEPLOYMENT

Railway auto-deploys from GitHub main branch. After pushing:

1. Watch Railway dashboard for build status
2. Check logs for any errors
3. Test `/health` endpoint
4. Test URL conversion with a simple URL
5. Test full exhibit generation workflow

---

## CONTACTS

- **GitHub Repo:** IGTA-Tech/exhibit-maker-real-project
- **Railway:** exhibit-maker project
- **Support Email:** applications@innovativeglobaltalent.agency

---

## QUICK START FOR DEVELOPER

```bash
# Clone the repo
git clone https://github.com/IGTA-Tech/exhibit-maker-real-project.git
cd exhibit-maker-real-project

# Install dependencies
npm install

# Copy environment template
cp .env.example .env
# Fill in the values (get from Railway variables)

# Run locally
npm start

# Test health endpoint
curl http://localhost:3000/health

# Run in development mode with auto-reload
npm run dev
```

---

*Last Updated: 2026-01-26*
