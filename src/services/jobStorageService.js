/**
 * Job Storage Service
 * Provides persistent job storage with Supabase, falling back to in-memory
 */

const supabaseService = require('./supabaseService');

// In-memory fallback storage
const memoryJobs = new Map();

// Convert job object to database format
function toDbFormat(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    total_urls: job.totalUrls,
    processed_urls: job.processedUrls,
    success_count: job.successCount,
    failed_count: job.failedCount,
    delivery_method: job.deliveryMethod,
    recipient_email: job.recipientEmail,
    folder_name: job.folderName,
    delivery_result: job.deliveryResult,
    error: job.error,
    logs: job.logs,
    created_at: job.createdAt,
    updated_at: new Date().toISOString(),
    completed_at: job.completedAt,
  };
}

// Convert database record to job object
function fromDbFormat(record) {
  return {
    id: record.id,
    status: record.status,
    progress: record.progress,
    totalUrls: record.total_urls,
    processedUrls: record.processed_urls,
    successCount: record.success_count,
    failedCount: record.failed_count,
    deliveryMethod: record.delivery_method,
    recipientEmail: record.recipient_email,
    folderName: record.folder_name,
    deliveryResult: record.delivery_result,
    error: record.error,
    logs: record.logs || [],
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    completedAt: record.completed_at,
  };
}

/**
 * Initialize the storage service
 */
async function initialize() {
  supabaseService.initialize();

  if (supabaseService.isAvailable()) {
    console.log('Job storage: Using Supabase');
    await supabaseService.ensureTablesExist();
  } else {
    console.log('Job storage: Using in-memory (jobs will not persist across restarts)');
  }
}

/**
 * Create a new job
 */
async function createJob(job) {
  const supabase = supabaseService.getClient();

  if (supabase) {
    try {
      const dbJob = toDbFormat(job);
      const { data, error } = await supabase
        .from('pdf_jobs')
        .insert(dbJob)
        .select()
        .single();

      if (error) {
        console.error('Supabase create error:', error.message);
        // Fall back to memory
        memoryJobs.set(job.id, job);
        return job;
      }

      return fromDbFormat(data);
    } catch (err) {
      console.error('Create job error:', err.message);
      memoryJobs.set(job.id, job);
      return job;
    }
  }

  memoryJobs.set(job.id, job);
  return job;
}

/**
 * Get a job by ID
 */
async function getJob(jobId) {
  const supabase = supabaseService.getClient();

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('pdf_jobs')
        .select('*')
        .eq('id', jobId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // Not found in DB, check memory
          return memoryJobs.get(jobId) || null;
        }
        console.error('Supabase get error:', error.message);
        return memoryJobs.get(jobId) || null;
      }

      return fromDbFormat(data);
    } catch (err) {
      console.error('Get job error:', err.message);
      return memoryJobs.get(jobId) || null;
    }
  }

  return memoryJobs.get(jobId) || null;
}

/**
 * Update a job
 */
async function updateJob(jobId, updates) {
  const supabase = supabaseService.getClient();

  if (supabase) {
    try {
      // Get current job to merge with updates
      const currentJob = await getJob(jobId);
      if (!currentJob) {
        return null;
      }

      const updatedJob = { ...currentJob, ...updates };
      const dbJob = toDbFormat(updatedJob);

      const { data, error } = await supabase
        .from('pdf_jobs')
        .update(dbJob)
        .eq('id', jobId)
        .select()
        .single();

      if (error) {
        console.error('Supabase update error:', error.message);
        // Fall back to memory
        if (memoryJobs.has(jobId)) {
          const job = { ...memoryJobs.get(jobId), ...updates };
          memoryJobs.set(jobId, job);
          return job;
        }
        return null;
      }

      return fromDbFormat(data);
    } catch (err) {
      console.error('Update job error:', err.message);
      if (memoryJobs.has(jobId)) {
        const job = { ...memoryJobs.get(jobId), ...updates };
        memoryJobs.set(jobId, job);
        return job;
      }
      return null;
    }
  }

  if (memoryJobs.has(jobId)) {
    const job = { ...memoryJobs.get(jobId), ...updates };
    memoryJobs.set(jobId, job);
    return job;
  }

  return null;
}

/**
 * Add a log entry to a job
 */
async function addLog(jobId, message) {
  const job = await getJob(jobId);
  if (!job) {
    return null;
  }

  const logEntry = {
    time: new Date().toISOString(),
    message,
  };

  const logs = [...(job.logs || []), logEntry];
  return updateJob(jobId, { logs });
}

/**
 * Delete a job
 */
async function deleteJob(jobId) {
  const supabase = supabaseService.getClient();

  if (supabase) {
    try {
      const { error } = await supabase
        .from('pdf_jobs')
        .delete()
        .eq('id', jobId);

      if (error) {
        console.error('Supabase delete error:', error.message);
      }
    } catch (err) {
      console.error('Delete job error:', err.message);
    }
  }

  memoryJobs.delete(jobId);
}

/**
 * Get all jobs (with optional filters)
 */
async function getJobs(filters = {}) {
  const supabase = supabaseService.getClient();

  if (supabase) {
    try {
      let query = supabase
        .from('pdf_jobs')
        .select('*')
        .order('created_at', { ascending: false });

      if (filters.status) {
        query = query.eq('status', filters.status);
      }

      if (filters.limit) {
        query = query.limit(filters.limit);
      }

      const { data, error } = await query;

      if (error) {
        console.error('Supabase getJobs error:', error.message);
        return Array.from(memoryJobs.values());
      }

      return data.map(fromDbFormat);
    } catch (err) {
      console.error('Get jobs error:', err.message);
      return Array.from(memoryJobs.values());
    }
  }

  return Array.from(memoryJobs.values());
}

/**
 * Cleanup old completed/failed jobs
 * Call this periodically to prevent storage from growing indefinitely
 */
async function cleanupOldJobs(olderThanHours = 24) {
  const supabase = supabaseService.getClient();
  const cutoffDate = new Date(Date.now() - olderThanHours * 60 * 60 * 1000).toISOString();

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('pdf_jobs')
        .delete()
        .in('status', ['completed', 'failed'])
        .lt('created_at', cutoffDate)
        .select();

      if (error) {
        console.error('Cleanup error:', error.message);
      } else {
        console.log(`Cleaned up ${data?.length || 0} old jobs`);
      }
    } catch (err) {
      console.error('Cleanup error:', err.message);
    }
  }

  // Also cleanup memory jobs
  for (const [id, job] of memoryJobs) {
    if (
      ['completed', 'failed'].includes(job.status) &&
      new Date(job.createdAt) < new Date(cutoffDate)
    ) {
      memoryJobs.delete(id);
    }
  }
}

/**
 * Check if using persistent storage
 */
function isPersistent() {
  return supabaseService.isAvailable();
}

module.exports = {
  initialize,
  createJob,
  getJob,
  updateJob,
  addLog,
  deleteJob,
  getJobs,
  cleanupOldJobs,
  isPersistent,
};
