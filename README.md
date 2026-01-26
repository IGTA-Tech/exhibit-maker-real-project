# URL to PDF Converter Tool

A web-based tool that converts multiple URLs to PDFs and delivers them via Google Drive (shared folder) or Email (ZIP attachment).

## Features

- **Multiple Input Methods**: Paste URLs directly or upload TXT/CSV/JSON files
- **Batch Processing**: Converts URLs in parallel with rate limiting
- **Google Drive Delivery**: Creates a shared folder and sends invite to recipient
- **Email Delivery**: Sends a ZIP file with all PDFs (max 25MB)
- **Progress Tracking**: Real-time progress updates and activity log
- **Index File**: Automatically generates an index of all converted PDFs

## Quick Start

### 1. Install Dependencies

```bash
cd url-to-pdf-tool
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Required: api2pdf API key
API2PDF_API_KEY=your_api2pdf_key_here

# For Google Drive delivery
GOOGLE_CREDENTIALS_PATH=./credentials.json

# For Email delivery (Gmail example)
EMAIL_SERVICE=gmail
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
```

### 3. Set Up Google Drive (Optional)

If you want to use Google Drive delivery:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable the **Google Drive API**:
   - Go to "APIs & Services" > "Library"
   - Search for "Google Drive API"
   - Click "Enable"
4. Create OAuth credentials:
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "OAuth client ID"
   - Application type: **Desktop app**
   - Download the JSON file
5. Rename it to `credentials.json` and place in project root
6. Run the setup script:

```bash
node setup-google-auth.js
```

### 4. Set Up Email (Optional)

For Gmail:
1. Go to [Google Account Security](https://myaccount.google.com/security)
2. Enable 2-Step Verification
3. Generate an "App Password" for Mail
4. Use that password in `.env`

For other providers (SendGrid, etc.):
```env
EMAIL_HOST=smtp.sendgrid.net
EMAIL_PORT=587
EMAIL_USER=apikey
EMAIL_PASSWORD=your-sendgrid-api-key
```

### 5. Run the Server

```bash
npm start
```

Open http://localhost:3000 in your browser.

## Usage

### Via Web Interface

1. **Add URLs**: Either paste URLs (one per line) or upload a file
2. **Enter recipient email**: Where to send/share the PDFs
3. **Choose delivery method**: Google Drive or Email
4. **Click "Start Conversion"**

### URL Input Formats

**Plain text (one per line):**
```
https://example.com/page1
https://example.com/page2
https://example.com/page3
```

**CSV format (URL, label, filename):**
```
https://example.com/page1, Page 1 Description, page1.pdf
https://example.com/page2, Page 2 Description, page2.pdf
```

**JSON format:**
```json
[
  {
    "url": "https://example.com/page1",
    "label": "Page 1 Description",
    "fileName": "page1.pdf"
  },
  {
    "url": "https://example.com/page2",
    "label": "Page 2 Description"
  }
]
```

### Via API

**Start conversion:**
```bash
curl -X POST http://localhost:3000/api/pdf/convert \
  -H "Content-Type: application/json" \
  -d '{
    "urlText": "https://example.com/page1\nhttps://example.com/page2",
    "recipientEmail": "recipient@example.com",
    "deliveryMethod": "drive",
    "folderName": "My PDFs"
  }'
```

**Check status:**
```bash
curl http://localhost:3000/api/pdf/status/{jobId}
```

## Project Structure

```
url-to-pdf-tool/
├── public/
│   ├── css/
│   │   └── styles.css
│   ├── js/
│   │   └── app.js
│   └── index.html
├── src/
│   ├── routes/
│   │   └── pdf.js
│   ├── services/
│   │   ├── pdfService.js
│   │   ├── googleDriveService.js
│   │   └── emailService.js
│   └── server.js
├── uploads/           # Temporary file uploads
├── temp/              # Temporary PDF storage
├── .env.example
├── credentials.json   # Google OAuth credentials
├── token.json         # Google OAuth token (auto-generated)
├── package.json
├── setup-google-auth.js
└── README.md
```

## API Reference

### POST /api/pdf/convert

Start a PDF conversion job.

**Request Body:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| urlText | string | * | URLs (one per line or CSV format) |
| urlFile | file | * | Upload file with URLs |
| recipientEmail | string | Yes | Email to send/share PDFs |
| deliveryMethod | string | Yes | "drive" or "email" |
| folderName | string | No | Custom folder/project name |

*Either `urlText` or `urlFile` is required

**Response:**
```json
{
  "success": true,
  "jobId": "abc123",
  "message": "Started processing 10 URLs",
  "statusUrl": "/api/pdf/status/abc123"
}
```

### GET /api/pdf/status/:jobId

Get job status.

**Response:**
```json
{
  "id": "abc123",
  "status": "processing|uploading|sending|completed|failed",
  "progress": 75,
  "totalUrls": 10,
  "successCount": 7,
  "failedCount": 1,
  "deliveryResult": {
    "method": "Google Drive",
    "shareLink": "https://drive.google.com/..."
  },
  "logs": [...]
}
```

## Troubleshooting

### "Google credentials file not found"
- Make sure `credentials.json` is in the project root
- Run `node setup-google-auth.js` to authorize

### "OAuth token expired"
- Delete `token.json` and run `node setup-google-auth.js` again

### "ZIP file too large"
- Email attachments are limited to 25MB
- Use Google Drive delivery for large batches

### "api2pdf conversion failed"
- Some websites block automated access
- Try increasing the delay in conversion options

## License

MIT
