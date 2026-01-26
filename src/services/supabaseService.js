/**
 * Supabase Client Service
 * Provides database and storage operations for persistent job storage
 */

const { createClient } = require('@supabase/supabase-js');

let supabase = null;
let isInitialized = false;

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
 * Create the pdf_jobs table if it doesn't exist
 * This should be run once during setup, not on every request
 */
async function ensureTablesExist() {
  if (!isAvailable()) {
    return { success: false, error: 'Supabase not available' };
  }

  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS pdf_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      status TEXT DEFAULT 'pending',
      progress INTEGER DEFAULT 0,
      total_urls INTEGER,
      processed_urls INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      delivery_method TEXT,
      recipient_email TEXT,
      folder_name TEXT,
      delivery_result JSONB,
      error TEXT,
      logs JSONB DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      completed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_pdf_jobs_status ON pdf_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_pdf_jobs_created_at ON pdf_jobs(created_at);
  `;

  try {
    const { error } = await supabase.rpc('exec_sql', { sql: createTableSQL });
    if (error) {
      // Table might already exist, which is fine
      console.log('Table creation note:', error.message);
    }
    return { success: true };
  } catch (error) {
    console.error('Error ensuring tables exist:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Upload a file to Supabase Storage
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
 * Delete a file from Supabase Storage
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
  ensureTablesExist,
  uploadFile,
  deleteFile,
};
