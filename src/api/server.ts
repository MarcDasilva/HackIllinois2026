/**
 * Express API Server
 * 
 * REST API endpoints for Google Drive + VeilDoc encryption backend
 */

import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';
import * as googleDrive from './googleDrive';
import * as encryptionWorkflow from './encryptionWorkflow';
import type { WebhookNotification } from '../types/encryption';

// ── Configuration ────────────────────────────────────────────

const PORT = parseInt(process.env.API_PORT || '3000', 10);
const HOST = process.env.API_HOST || '0.0.0.0';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const WEBHOOK_RENEWAL_INTERVAL = parseInt(
  process.env.WEBHOOK_RENEWAL_INTERVAL_MS || '43200000', // 12 hours
  10
);

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Express App Setup ────────────────────────────────────────

const app = express();

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`[API] ${req.method} ${req.path}`);
  next();
});

// ── API Endpoints ────────────────────────────────────────────

/**
 * GET /api/health
 * Health check endpoint
 */
app.get('/api/health', async (req: Request, res: Response) => {
  try {
    // Check dependencies
    const pythonDeps = await require('./veilDoc').checkPythonDependencies();
    
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      dependencies: {
        python: pythonDeps.pythonInstalled,
        pythonVersion: pythonDeps.pythonVersion,
        pymupdf: pythonDeps.pymupdfInstalled,
        veildocScript: pythonDeps.veildocScriptExists,
        unveildocScript: pythonDeps.unveildocScriptExists,
      },
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/drive/files
 * List files from Google Drive
 * Query params: folderId, pageToken, mimeType
 */
app.get('/api/drive/files', async (req: Request, res: Response) => {
  try {
    const { folderId, pageToken, mimeType } = req.query;
    
    const result = await googleDrive.listFiles({
      folderId: folderId as string | undefined,
      pageToken: pageToken as string | undefined,
      mimeType: mimeType as string | undefined,
    });
    
    res.json(result);
  } catch (error) {
    console.error('[API] Error listing files:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to list files',
    });
  }
});

/**
 * POST /api/drive/encrypt
 * Encrypt selected files and enable continuous monitoring
 * Body: { fileIds: string[], mode: 'full' | 'pattern', replaceOriginal: boolean }
 */
app.post('/api/drive/encrypt', async (req: Request, res: Response) => {
  try {
    const { fileIds, mode, replaceOriginal } = req.body;
    
    if (!fileIds || !Array.isArray(fileIds) || fileIds.length === 0) {
      return res.status(400).json({
        error: 'fileIds must be a non-empty array',
      });
    }
    
    if (mode && mode !== 'full' && mode !== 'pattern') {
      return res.status(400).json({
        error: 'mode must be either "full" or "pattern"',
      });
    }
    
    const jobId = await encryptionWorkflow.startEncryptionJob(
      fileIds,
      mode || 'pattern',
      replaceOriginal || false
    );
    
    res.json({
      jobId,
      status: 'started',
      message: `Encryption job started for ${fileIds.length} file(s)`,
    });
  } catch (error) {
    console.error('[API] Error starting encryption job:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to start encryption job',
    });
  }
});

/**
 * GET /api/drive/status/:jobId
 * Check encryption job status
 */
app.get('/api/drive/status/:jobId', (req: Request, res: Response) => {
  try {
    const jobId = Array.isArray(req.params.jobId) ? req.params.jobId[0] : req.params.jobId;
    
    const job = encryptionWorkflow.getJobStatus(jobId);
    
    if (!job) {
      return res.status(404).json({
        error: 'Job not found',
      });
    }
    
    res.json(job);
  } catch (error) {
    console.error('[API] Error fetching job status:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch job status',
    });
  }
});

/**
 * POST /api/drive/disable-encryption
 * Stop monitoring a file
 * Body: { fileId: string }
 */
app.post('/api/drive/disable-encryption', async (req: Request, res: Response) => {
  try {
    const { fileId } = req.body;
    
    if (!fileId) {
      return res.status(400).json({
        error: 'fileId is required',
      });
    }
    
    await encryptionWorkflow.disableEncryption(fileId);
    
    res.json({
      success: true,
      message: `Encryption disabled for file ${fileId}`,
    });
  } catch (error) {
    console.error('[API] Error disabling encryption:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to disable encryption',
    });
  }
});

/**
 * POST /api/drive/webhook
 * Webhook callback from Google Drive
 */
app.post('/api/drive/webhook', async (req: Request, res: Response) => {
  try {
    const headers = req.headers as Record<string, string | string[] | undefined>;
    
    // Verify webhook signature
    if (!googleDrive.verifyWebhookSignature(headers, req.body)) {
      return res.status(401).json({
        error: 'Invalid webhook signature',
      });
    }
    
    // Extract webhook info
    const resourceState = headers['x-goog-resource-state'] as string;
    const resourceId = headers['x-goog-resource-id'] as string;
    const channelId = headers['x-goog-channel-id'] as string;
    
    console.log(`[API] Webhook received: state=${resourceState}, channelId=${channelId}`);
    
    // Ignore sync events (initial webhook setup confirmation)
    if (resourceState === 'sync') {
      return res.status(200).json({ status: 'ok', action: 'ignored_sync' });
    }
    
    // Look up document by webhook channel ID
    const { data: docs, error } = await supabase
      .from('documents')
      .select('*')
      .eq('webhook_channel_id', channelId)
      .eq('encryption_enabled', true);
    
    if (error || !docs || docs.length === 0) {
      return res.status(200).json({ status: 'ok', action: 'file_not_tracked' });
    }
    
    const doc = docs[0];
    
    // Fetch latest file metadata from Drive
    const metadata = await googleDrive.getFileMetadata(doc.google_drive_id);
    
    // Check if file content actually changed (not just viewed/shared)
    if (metadata.modifiedTime === doc.drive_modified_time) {
      return res.status(200).json({ status: 'ok', action: 'no_content_change' });
    }
    
    // Trigger re-encryption asynchronously
    encryptionWorkflow.reEncryptFile(doc.id).catch((error) => {
      console.error('[API] Re-encryption failed:', error);
    });
    
    res.status(200).json({ status: 'ok', action: 're_encryption_triggered' });
  } catch (error) {
    console.error('[API] Webhook handler error:', error);
    // Return 200 to avoid webhook retries
    res.status(200).json({
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/documents
 * List encrypted documents from Supabase
 * Query params: encryption_enabled (filter by active monitoring)
 */
app.get('/api/documents', async (req: Request, res: Response) => {
  try {
    const { encryption_enabled, status } = req.query;
    
    let query = supabase.from('documents').select('*');
    
    if (encryption_enabled === 'true') {
      query = query.eq('encryption_enabled', true);
    } else if (encryption_enabled === 'false') {
      query = query.eq('encryption_enabled', false);
    }
    
    if (status) {
      query = query.eq('encryption_status', status);
    }
    
    const { data, error } = await query.order('updated_at', { ascending: false });
    
    if (error) {
      throw error;
    }
    
    res.json({
      documents: data || [],
      count: data?.length || 0,
    });
  } catch (error) {
    console.error('[API] Error fetching documents:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to fetch documents',
    });
  }
});

// ── Error Handling ───────────────────────────────────────────

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
  });
});

// Global error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('[API] Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// ── Server Startup ───────────────────────────────────────────

/**
 * Start the API server
 */
export async function startServer(): Promise<void> {
  try {
    console.log('[API] Starting server...');
    
    // Initialize Google Drive client (optional in development)
    try {
      await googleDrive.initDriveClient();
      console.log('[API] ✓ Google Drive client initialized');
    } catch (error) {
      console.warn('[API] ⚠ Warning: Failed to initialize Google Drive client');
      console.warn('[API] Google Drive features will be disabled');
      console.warn('[API] Error:', error instanceof Error ? error.message : 'Unknown error');
      console.warn('[API] Make sure GOOGLE_SERVICE_ACCOUNT_PATH is set and the file exists');
    }
    
    // Start webhook renewal background task
    setInterval(async () => {
      try {
        const renewed = await encryptionWorkflow.renewExpiringWebhooks();
        if (renewed > 0) {
          console.log(`[API] Renewed ${renewed} webhooks`);
        }
      } catch (error) {
        console.error('[API] Webhook renewal error:', error);
      }
    }, WEBHOOK_RENEWAL_INTERVAL);
    
    console.log(`[API] Webhook renewal task scheduled (interval: ${WEBHOOK_RENEWAL_INTERVAL}ms)`);
    
    // Start Express server
    app.listen(PORT, HOST, () => {
      console.log(`[API] ✓ Server listening on ${HOST}:${PORT}`);
      console.log(`[API] Health check: http://${HOST}:${PORT}/api/health`);
      console.log('[API]');
      console.log('[API] Available endpoints:');
      console.log('[API]   GET  /api/health');
      console.log('[API]   GET  /api/drive/files');
      console.log('[API]   POST /api/drive/encrypt');
      console.log('[API]   GET  /api/drive/status/:jobId');
      console.log('[API]   POST /api/drive/disable-encryption');
      console.log('[API]   POST /api/drive/webhook');
      console.log('[API]   GET  /api/documents');
    });
  } catch (error) {
    console.error('[API] Failed to start server:', error);
    process.exit(1);
  }
}

// ── Exports ──────────────────────────────────────────────────

export { app };
export default { startServer, app };
