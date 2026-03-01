/**
 * Encryption Workflow Module
 * 
 * Orchestrates the end-to-end encryption workflow including:
 * - Downloading files from Google Drive
 * - Encrypting with VeilDoc
 * - Uploading encrypted versions back to Drive
 * - Managing webhooks for continuous monitoring
 * - Storing metadata in Supabase
 */

import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, extname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createClient } from '@supabase/supabase-js';
import * as googleDrive from './googleDrive';
import * as veilDoc from './veilDoc';
import type { EncryptedDocument, EncryptionJob, EncryptionJobResult, EncryptionMode } from '../types/encryption';

// ── Configuration ────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TEMP_DIR = process.env.VEILDOC_TEMP_DIR || tmpdir();
const DEFAULT_MODE = (process.env.VEILDOC_DEFAULT_MODE || 'pattern') as EncryptionMode;

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// In-memory job storage (replace with Redis/database for production)
const jobs = new Map<string, EncryptionJob>();

// ── Main Workflow Functions ──────────────────────────────────

/**
 * Start encryption job for multiple files
 * 
 * @param fileIds - Google Drive file IDs to encrypt
 * @param mode - Encryption mode ('full' or 'pattern')
 * @param replaceOriginal - Whether to replace original file in Drive
 * @returns Job ID for tracking progress
 */
export async function startEncryptionJob(
  fileIds: string[],
  mode: EncryptionMode = DEFAULT_MODE,
  replaceOriginal: boolean = false
): Promise<string> {
  const jobId = uuidv4();
  
  const job: EncryptionJob = {
    id: jobId,
    fileIds,
    mode,
    replaceOriginal,
    status: 'pending',
    progress: {
      total: fileIds.length,
      completed: 0,
      failed: 0,
    },
    results: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  
  jobs.set(jobId, job);
  
  // Process files asynchronously
  processEncryptionJob(jobId).catch((error) => {
    console.error(`[encryptionWorkflow] Job ${jobId} failed:`, error);
    job.status = 'failed';
    job.updatedAt = new Date();
  });
  
  return jobId;
}

/**
 * Get encryption job status
 * 
 * @param jobId - Job ID
 * @returns Job details or null if not found
 */
export function getJobStatus(jobId: string): EncryptionJob | null {
  return jobs.get(jobId) || null;
}

/**
 * Process encryption job (internal)
 */
async function processEncryptionJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }
  
  job.status = 'in_progress';
  job.updatedAt = new Date();
  
  console.log(`[encryptionWorkflow] Starting job ${jobId} with ${job.fileIds.length} files`);
  
  for (const fileId of job.fileIds) {
    try {
      const result = await encryptFile(fileId, job.mode, job.replaceOriginal);
      job.results.push(result);
      job.progress.completed++;
      
      if (result.status === 'failed') {
        job.progress.failed++;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[encryptionWorkflow] Failed to encrypt file ${fileId}:`, errorMessage);
      
      job.results.push({
        fileId,
        fileName: 'Unknown',
        status: 'failed',
        error: errorMessage,
      });
      job.progress.failed++;
    }
    
    job.updatedAt = new Date();
  }
  
  job.status = 'completed';
  console.log(`[encryptionWorkflow] Job ${jobId} completed: ${job.progress.completed} succeeded, ${job.progress.failed} failed`);
}

/**
 * Encrypt a single file (core workflow)
 * 
 * @param fileId - Google Drive file ID
 * @param mode - Encryption mode
 * @param replaceOriginal - Whether to replace original
 * @returns Encryption result
 */
export async function encryptFile(
  fileId: string,
  mode: EncryptionMode = DEFAULT_MODE,
  replaceOriginal: boolean = false
): Promise<EncryptionJobResult> {
  let tempDir: string | null = null;
  
  try {
    // 1. Fetch file metadata from Drive
    console.log(`[encryptionWorkflow] Fetching metadata for file ${fileId}`);
    const metadata = await googleDrive.getFileMetadata(fileId);
    
    // 2. Check if file type is supported
    if (!veilDoc.isMimeTypeSupported(metadata.mimeType)) {
      throw new Error(`Unsupported file type: ${metadata.mimeType}`);
    }
    
    // 3. Create or update document record in database
    const existingDoc = await getDocumentByDriveId(fileId);
    const documentId = existingDoc?.id || uuidv4();
    
    const title = metadata.name?.trim() || '(Untitled)';
    await upsertDocument({
      id: documentId,
      title,
      google_drive_id: fileId,
      google_drive_name: metadata.name,
      encryption_status: 'pending',
      encryption_method: mode === 'full' ? 'veildoc_full' : 'veildoc_pattern',
      encryption_enabled: true,
      original_drive_url: googleDrive.buildFileUrl(fileId),
      drive_modified_time: metadata.modifiedTime,
    });
    
    // 4. Set up webhook for continuous monitoring
    console.log(`[encryptionWorkflow] Creating webhook for file ${fileId}`);
    const webhook = await googleDrive.createWebhook(fileId);
    
    await updateDocumentWebhook(documentId, {
      webhook_channel_id: webhook.id,
      webhook_resource_id: webhook.resourceId,
      webhook_expiration: new Date(parseInt(webhook.expiration)),
    });
    
    // 5. Update status to processing
    await updateDocumentStatus(documentId, 'processing');
    
    // 6. Create temp directory
    tempDir = await mkdtemp(join(TEMP_DIR, 'veildoc-'));
    
    // 7. Download file from Drive
    const ext = veilDoc.getExtensionForMimeType(metadata.mimeType) || extname(metadata.name);
    const inputPath = join(tempDir, `input${ext}`);
    console.log(`[encryptionWorkflow] Downloading file to ${inputPath}`);
    await googleDrive.downloadFile(fileId, inputPath);
    
    // 8. Encrypt document with VeilDoc
    console.log(`[encryptionWorkflow] Encrypting document with mode=${mode}`);
    const encryptionResult = await veilDoc.encryptDocument(inputPath, mode);
    
    // 9. Upload encrypted file back to Drive
    console.log(`[encryptionWorkflow] Uploading encrypted file to Drive`);
    const uploadedFile = await googleDrive.uploadFile(
      encryptionResult.outputPath,
      {
        name: metadata.name, // Keep same name
        mimeType: metadata.mimeType,
        replaceFileId: replaceOriginal ? fileId : undefined,
      }
    );
    
    const encryptedFileId = uploadedFile.id;
    
    // 10. Store sidecar JSON in database
    await updateDocument(documentId, {
      encryption_status: 'encrypted',
      encrypted_drive_url: googleDrive.buildFileUrl(encryptedFileId),
      sidecar_json: encryptionResult.metadata,
      last_encrypted_at: new Date().toISOString(),
      error_message: null,
    });
    
    // 11. Clean up temp directory
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    
    console.log(`[encryptionWorkflow] Successfully encrypted file ${fileId}`);
    
    return {
      fileId,
      fileName: metadata.name,
      status: 'success',
      documentId,
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[encryptionWorkflow] Error encrypting file ${fileId}:`, errorMessage);
    
    // Update database with error
    const existingDoc = await getDocumentByDriveId(fileId);
    if (existingDoc) {
      await updateDocument(existingDoc.id, {
        encryption_status: 'failed',
        error_message: errorMessage,
      });
    }
    
    // Clean up temp directory
    if (tempDir) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error('[encryptionWorkflow] Failed to clean up temp directory:', cleanupError);
      }
    }
    
    return {
      fileId,
      fileName: 'Unknown',
      status: 'failed',
      error: errorMessage,
    };
  }
}

/**
 * Re-encrypt a file (triggered by webhook)
 * 
 * @param documentId - Document ID in database
 * @returns Promise resolving when re-encryption is complete
 */
export async function reEncryptFile(documentId: string): Promise<void> {
  const doc = await getDocument(documentId);
  
  if (!doc || !doc.google_drive_id) {
    throw new Error(`Document ${documentId} not found or missing Drive ID`);
  }
  
  if (!doc.encryption_enabled) {
    console.log(`[encryptionWorkflow] Encryption disabled for document ${documentId}, skipping re-encryption`);
    return;
  }
  
  const mode: EncryptionMode = doc.encryption_method === 'veildoc_full' ? 'full' : 'pattern';
  
  console.log(`[encryptionWorkflow] Re-encrypting file ${doc.google_drive_id}`);
  await encryptFile(doc.google_drive_id, mode, true); // Always replace on re-encryption
}

/**
 * Disable encryption for a file
 * 
 * @param fileId - Google Drive file ID
 * @returns Promise resolving when encryption is disabled
 */
export async function disableEncryption(fileId: string): Promise<void> {
  const doc = await getDocumentByDriveId(fileId);
  
  if (!doc) {
    throw new Error(`Document with Drive ID ${fileId} not found`);
  }
  
  // Stop webhook
  if (doc.webhook_channel_id && doc.webhook_resource_id) {
    try {
      await googleDrive.stopWebhook(doc.webhook_channel_id, doc.webhook_resource_id);
    } catch (error) {
      console.warn(`[encryptionWorkflow] Failed to stop webhook:`, error);
    }
  }
  
  // Update database
  await updateDocument(doc.id, {
    encryption_enabled: false,
    webhook_channel_id: null,
    webhook_resource_id: null,
    webhook_expiration: null,
  });
  
  console.log(`[encryptionWorkflow] Disabled encryption for file ${fileId}`);
}

// ── Database Helper Functions ────────────────────────────────

async function getDocument(id: string): Promise<EncryptedDocument | null> {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('id', id)
    .single();
  
  if (error) {
    console.error('[encryptionWorkflow] Error fetching document:', error);
    return null;
  }
  
  return data as EncryptedDocument;
}

async function getDocumentByDriveId(driveId: string): Promise<EncryptedDocument | null> {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('google_drive_id', driveId)
    .single();
  
  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
    console.error('[encryptionWorkflow] Error fetching document by Drive ID:', error);
  }
  
  return data as EncryptedDocument | null;
}

async function upsertDocument(doc: Partial<EncryptedDocument>): Promise<void> {
  const { error } = await supabase
    .from('documents')
    .upsert(doc, { onConflict: 'id' });
  
  if (error) {
    throw new Error(`Failed to upsert document: ${error.message}`);
  }
}

async function updateDocument(id: string, updates: Partial<EncryptedDocument>): Promise<void> {
  const { error } = await supabase
    .from('documents')
    .update(updates)
    .eq('id', id);
  
  if (error) {
    throw new Error(`Failed to update document: ${error.message}`);
  }
}

async function updateDocumentStatus(id: string, status: string): Promise<void> {
  await updateDocument(id, { encryption_status: status as any });
}

async function updateDocumentWebhook(id: string, webhook: {
  webhook_channel_id: string;
  webhook_resource_id: string;
  webhook_expiration: Date;
}): Promise<void> {
  await updateDocument(id, {
    webhook_channel_id: webhook.webhook_channel_id,
    webhook_resource_id: webhook.webhook_resource_id,
    webhook_expiration: webhook.webhook_expiration.toISOString(),
  });
}

// ── Webhook Renewal ──────────────────────────────────────────

/**
 * Renew expiring webhooks (should be called periodically)
 * 
 * @returns Promise resolving to number of webhooks renewed
 */
export async function renewExpiringWebhooks(): Promise<number> {
  const sixHoursFromNow = new Date(Date.now() + 6 * 60 * 60 * 1000);
  
  const { data: expiringDocs, error } = await supabase
    .from('documents')
    .select('*')
    .eq('encryption_enabled', true)
    .lt('webhook_expiration', sixHoursFromNow.toISOString())
    .not('webhook_channel_id', 'is', null);
  
  if (error) {
    console.error('[encryptionWorkflow] Error fetching expiring webhooks:', error);
    return 0;
  }
  
  if (!expiringDocs || expiringDocs.length === 0) {
    return 0;
  }
  
  console.log(`[encryptionWorkflow] Renewing ${expiringDocs.length} expiring webhooks`);
  
  let renewed = 0;
  
  for (const doc of expiringDocs as EncryptedDocument[]) {
    try {
      if (!doc.google_drive_id || !doc.webhook_channel_id || !doc.webhook_resource_id) {
        continue;
      }
      
      const newWebhook = await googleDrive.renewWebhook(
        doc.google_drive_id,
        doc.webhook_channel_id,
        doc.webhook_resource_id
      );
      
      await updateDocumentWebhook(doc.id, {
        webhook_channel_id: newWebhook.id,
        webhook_resource_id: newWebhook.resourceId,
        webhook_expiration: new Date(parseInt(newWebhook.expiration)),
      });
      
      renewed++;
    } catch (error) {
      console.error(`[encryptionWorkflow] Failed to renew webhook for document ${doc.id}:`, error);
    }
  }
  
  console.log(`[encryptionWorkflow] Renewed ${renewed} webhooks`);
  return renewed;
}

// ── Exports ──────────────────────────────────────────────────

export default {
  startEncryptionJob,
  getJobStatus,
  encryptFile,
  reEncryptFile,
  disableEncryption,
  renewExpiringWebhooks,
};
