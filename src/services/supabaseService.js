/**
 * Supabase Client Service
 * Provides database and storage operations for persistent job storage
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

let supabase = null;
let isInitialized = false;

// Storage configuration
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'exhibit-packages';
const SIGNED_URL_EXPIRY = 7 * 24 * 60 * 60; // 7 days in seconds

/**
 * Initialize Supabase client
 */
function initialize() {
  if (isInitialized) {
    return supabase;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.warn('Supabase not configured. Using in-memory storage.');
    return null;
  }

  try {
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
    isInitialized = true;
    console.log('Supabase client initialized successfully');
    return supabase;
  } catch (error) {
    console.error('Failed to initialize Supabase:', error.message);
    return null;
  }
}

/**
 * Get Supabase client
 */
function getClient() {
  if (!isInitialized) {
    initialize();
  }
  return supabase;
}

/**
 * Check if Supabase is available
 */
function isAvailable() {
  return isInitialized && supabase !== null;
}

/**
 * Check if storage is available
 */
function isStorageAvailable() {
  return isAvailable();
}

/**
 * Ensure storage bucket exists
 */
async function ensureBucketExists() {
  if (!isAvailable()) {
    return { success: false, error: 'Supabase not available' };
  }

  try {
    // Check if bucket exists
    const { data: buckets, error: listError } = await supabase.storage.listBuckets();
    
    if (listError) {
      console.error('Error listing buckets:', listError.message);
      return { success: false, error: listError.message };
    }

    const bucketExists = buckets.some(b => b.name === STORAGE_BUCKET);
    
    if (!bucketExists) {
      // Create the bucket
      const { data, error: createError } = await supabase.storage.createBucket(STORAGE_BUCKET, {
        public: false, // Private bucket - use signed URLs
        fileSizeLimit: 100 * 1024 * 1024, // 100MB limit
        allowedMimeTypes: ['application/pdf', 'application/zip'],
      });

      if (createError) {
        // Bucket might already exist (race condition)
        if (!createError.message.includes('already exists')) {
          console.error('Error creating bucket:', createError.message);
          return { success: false, error: createError.message };
        }
      } else {
        console.log(`Created storage bucket: ${STORAGE_BUCKET}`);
      }
    }

    return { success: true, bucket: STORAGE_BUCKET };
  } catch (error) {
    console.error('Error ensuring bucket exists:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Upload a PDF file to Supabase Storage
 * @param {string} localPath - Path to the local file
 * @param {string} fileName - Desired filename in storage
 * @param {string} jobId - Job ID for organizing files
 * @returns {Promise<object>} - Upload result with signed URL
 */
async function uploadPdfToStorage(localPath, fileName, jobId) {
  if (!isAvailable()) {
    return { success: false, error: 'Supabase not available' };
  }

  try {
    // Ensure bucket exists
    const bucketResult = await ensureBucketExists();
    if (!bucketResult.success) {
      return bucketResult;
    }

    // Read file
    const fileBuffer = fs.readFileSync(localPath);
    const fileSize = fs.statSync(localPath).size;

    // Create storage path: jobs/{jobId}/{fileName}
    const storagePath = `jobs/${jobId}/${fileName}`;

    // Upload file
    const { data, error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(storagePath, fileBuffer, {
        contentType: 'application/pdf',
        upsert: true, // Overwrite if exists
      });

    if (uploadError) {
      console.error('Upload error:', uploadError.message);
      return { success: false, error: uploadError.message };
    }

    // Generate signed URL (valid for 7 days)
    const { data: signedUrlData, error: signedUrlError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(storagePath, SIGNED_URL_EXPIRY);

    if (signedUrlError) {
      console.error('Signed URL error:', signedUrlError.message);
      return { success: false, error: signedUrlError.message };
    }

    return {
      success: true,
      path: storagePath,
      signedUrl: signedUrlData.signedUrl,
      expiresIn: SIGNED_URL_EXPIRY,
      expiresAt: new Date(Date.now() + SIGNED_URL_EXPIRY * 1000).toISOString(),
      fileSize: fileSize,
      bucket: STORAGE_BUCKET,
    };

  } catch (error) {
    console.error('Error uploading to storage:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Get a new signed URL for an existing file
 * @param {string} storagePath - Path in storage
 * @param {number} expirySeconds - URL expiry time in seconds
 */
async function getSignedUrl(storagePath, expirySeconds = SIGNED_URL_EXPIRY) {
  if (!isAvailable()) {
    return { success: false, error: 'Supabase not available' };
  }

  try {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(storagePath, expirySeconds);

    if (error) {
      return { success: false, error: error.message };
    }

    return {
      success: true,
      signedUrl: data.signedUrl,
      expiresIn: expirySeconds,
      expiresAt: new Date(Date.now() + expirySeconds * 1000).toISOString(),
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Delete a file from storage
 * @param {string} storagePath - Path in storage
 */
async function deleteFromStorage(storagePath) {
  if (!isAvailable()) {
    return { success: false, error: 'Supabase not available' };
  }

  try {
    const { error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .remove([storagePath]);

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Delete all files for a job
 * @param {string} jobId - Job ID
 */
async function deleteJobFiles(jobId) {
  if (!isAvailable()) {
    return { success: false, error: 'Supabase not available' };
  }

  try {
    const folderPath = `jobs/${jobId}`;
    
    // List files in the job folder
    const { data: files, error: listError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .list(folderPath);

    if (listError) {
      return { success: false, error: listError.message };
    }

    if (files && files.length > 0) {
      const filePaths = files.map(f => `${folderPath}/${f.name}`);
      
      const { error: deleteError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .remove(filePaths);

      if (deleteError) {
        return { success: false, error: deleteError.message };
      }
    }

    return { success: true, deletedCount: files?.length || 0 };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Clean up old files from storage (files older than specified days)
 * @param {number} olderThanDays - Delete files older than this many days
 */
async function cleanupOldFiles(olderThanDays = 7) {
  if (!isAvailable()) {
    return { success: false, error: 'Supabase not available' };
  }

  try {
    const { data: folders, error: listError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .list('jobs');

    if (listError) {
      return { success: false, error: listError.message };
    }

    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    let deletedCount = 0;

    for (const folder of folders || []) {
      if (folder.created_at && new Date(folder.created_at) < cutoffDate) {
        const result = await deleteJobFiles(folder.name);
        if (result.success) {
          deletedCount += result.deletedCount || 0;
        }
      }
    }

    return { success: true, deletedCount };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Create the pdf_jobs table if it doesn't exist
 * This should be run once during setup, not on every request
 */
async function ensureTablesExist() {
  if (!isAvailable()) {
    return { success: false, error: 'Supabase not available' };
  }

  // Note: Table creation is handled via Supabase dashboard or migrations
  // This function just verifies the connection works
  try {
    const { data, error } = await supabase
      .from('pdf_jobs')
      .select('id')
      .limit(1);

    if (error && error.code === '42P01') {
      console.error('Table pdf_jobs does not exist. Please create it using the SQL schema.');
      return { success: false, error: 'Table does not exist' };
    }

    return { success: true };
  } catch (error) {
    console.error('Error checking tables:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Upload a file to Supabase Storage (legacy function for compatibility)
 */
async function uploadFile(bucket, filePath, fileBuffer, contentType = 'application/pdf') {
  if (!isAvailable()) {
    return { success: false, error: 'Supabase not available' };
  }

  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(filePath, fileBuffer, {
        contentType,
        upsert: true,
      });

    if (error) {
      throw error;
    }

    // Get public URL
    const { data: urlData } = supabase.storage
      .from(bucket)
      .getPublicUrl(filePath);

    return {
      success: true,
      path: data.path,
      publicUrl: urlData.publicUrl,
    };
  } catch (error) {
    console.error('Error uploading file:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Delete a file from Supabase Storage (legacy function for compatibility)
 */
async function deleteFile(bucket, filePath) {
  if (!isAvailable()) {
    return { success: false, error: 'Supabase not available' };
  }

  try {
    const { error } = await supabase.storage
      .from(bucket)
      .remove([filePath]);

    if (error) {
      throw error;
    }

    return { success: true };
  } catch (error) {
    console.error('Error deleting file:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  initialize,
  getClient,
  isAvailable,
  isStorageAvailable,
  ensureTablesExist,
  ensureBucketExists,
  uploadFile,
  deleteFile,
  // New storage functions
  uploadPdfToStorage,
  getSignedUrl,
  deleteFromStorage,
  deleteJobFiles,
  cleanupOldFiles,
  // Constants
  STORAGE_BUCKET,
  SIGNED_URL_EXPIRY,
};