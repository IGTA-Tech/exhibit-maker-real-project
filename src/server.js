require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const pdfRoutes = require('./routes/pdf');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Trust proxy for Railway/Heroku
app.set('trust proxy', 1);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      scriptSrcAttr: ["'unsafe-inline'"], // Allow inline event handlers (onclick, etc.)
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Compression
app.use(compression());

// CORS configuration
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3000'];

app.use(cors({
  origin: isProduction ? corsOrigins : true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ============================================
// Timeout and Large File Configuration
// ============================================

// Increase timeout for long-running requests (5 minutes)
app.use((req, res, next) => {
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000); // 5 minutes
  next();
});

// Rate limiting - Increased limits
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX) || 500, // 500 requests per 15 min per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => req.path === '/health' || req.path.startsWith('/api/pdf/status'), // Skip health and status checks
});
app.use(limiter);

// Rate limit for conversion endpoint (more generous)
const conversionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: parseInt(process.env.CONVERSION_RATE_LIMIT) || 500, // 500 conversions per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Conversion limit reached. Please try again later.', retryAfter: '1 hour' },
  skip: (req) => req.path.includes('/status') || req.method === 'GET', // Skip status checks and GET requests
});

// Body parsing - Increased limits for large files
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Static files
app.use(express.static(path.join(__dirname, '../public')));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Ensure temp directory exists
const tempDir = path.join(__dirname, '../temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Ensure output directory exists
const outputDir = path.join(__dirname, '../output');
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// File upload configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Sanitize filename
    const sanitized = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${uuidv4()}-${sanitized}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['.txt', '.csv', '.json', '.zip', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedTypes.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .txt, .csv, .json, .zip, and .pdf files are allowed'));
    }
  },
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    features: {
      puppeteer: true,
      supabase: !!process.env.SUPABASE_URL,
      googleDrive: !!process.env.GOOGLE_CREDENTIALS_BASE64,
      email: !!process.env.SENDGRID_API_KEY || !!process.env.EMAIL_PASSWORD,
    }
  });
});

// API routes - Note: multer is handled within pdf routes for specific endpoints
app.use('/api/pdf', conversionLimiter, pdfRoutes);

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err.message);

  // Handle multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large. Maximum size is 100MB.' });
  }

  // Handle timeout errors
  if (err.code === 'ETIMEDOUT' || err.message.includes('timeout')) {
    return res.status(504).json({ error: 'Request timeout. Please try with a smaller file or fewer URLs.' });
  }

  // Don't leak error details in production
  const message = isProduction ? 'An error occurred' : err.message;
  res.status(err.status || 500).json({ error: message });
});

// Start server with increased timeout
const server = app.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════════════════════════╗
  ║              Exhibit Maker - PDF Converter                 ║
  ║                                                            ║
  ║   Server running at: http://localhost:${PORT}                 ║
  ║   Environment: ${(process.env.NODE_ENV || 'development').padEnd(40)}║
  ║                                                            ║
  ║   Features:                                                ║
  ║   - URL to PDF conversion via Puppeteer                    ║
  ║   - Exhibit cover page generation                          ║
  ║   - Google Drive / Email delivery                          ║
  ║   - Supabase Storage for large files                       ║
  ║   - PDF Compression via Ghostscript                        ║
  ╚════════════════════════════════════════════════════════════╝
  `);
});

// Increase server timeout to 5 minutes
server.timeout = 300000;
server.keepAliveTimeout = 300000;
server.headersTimeout = 310000;

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`);

  // Close Puppeteer browser if running
  try {
    const pdfService = require('./services/pdfService');
    await pdfService.closeBrowser();
    console.log('Puppeteer browser closed.');
  } catch (e) {
    // Ignore if not initialized
  }

  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });

  // Force close after 30 seconds
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = app;