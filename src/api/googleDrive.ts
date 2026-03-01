/**
 * Google Drive API Integration Module
 * 
 * Provides functions for interacting with Google Drive API including
 * file listing, downloading, uploading, and webhook management.
 */

import { google, drive_v3 } from 'googleapis';
import { JWT } from 'google-auth-library';
import { createReadStream, createWriteStream, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import type {
  DriveFile,
  DriveFileList,
  DriveWebhook,
  DriveFileMetadata,
  UploadOptions,
  ListFilesOptions,
} from '../types/googleDrive';

// ── Configuration ────────────────────────────────────────────

const SERVICE_ACCOUNT_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || './config/google-service-account.json';
const WEBHOOK_URL = process.env.GOOGLE_DRIVE_WEBHOOK_URL || '';
const SCOPES = ['https://www.googleapis.com/auth/drive'];

let driveClient: drive_v3.Drive | null = null;
let authClient: JWT | null = null;

// ── Initialization ───────────────────────────────────────────

/**
 * Initialize Google Drive API client with service account
 * 
 * @returns Promise resolving to Drive client
 */
export async function initDriveClient(): Promise<drive_v3.Drive> {
  if (driveClient) {
    return driveClient;
  }

  // Validate service account file exists
  if (!existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new Error(`Service account file not found: ${SERVICE_ACCOUNT_PATH}`);
  }

  // Load service account credentials
  const serviceAccountKey = JSON.parse(
    await readFile(SERVICE_ACCOUNT_PATH, 'utf-8')
  );

  // Create JWT auth client
  authClient = new google.auth.JWT({
    email: serviceAccountKey.client_email,
    key: serviceAccountKey.private_key,
    scopes: SCOPES,
  });

  // Authenticate
  await authClient.authorize();

  // Initialize Drive API client
  driveClient = google.drive({ version: 'v3', auth: authClient });

  console.log('[googleDrive] Drive client initialized successfully');
  return driveClient;
}

/**
 * Get initialized Drive client (throws if not initialized)
 */
function getDriveClient(): drive_v3.Drive {
  if (!driveClient) {
    throw new Error('Drive client not initialized. Call initDriveClient() first.');
  }
  return driveClient;
}

// ── File Operations ──────────────────────────────────────────

/**
 * List files from Google Drive with pagination
 * 
 * @param options - List options (folderId, pageToken, etc.)
 * @returns Promise resolving to file list
 */
export async function listFiles(options: ListFilesOptions = {}): Promise<DriveFileList> {
  const drive = getDriveClient();

  // Build query
  const queryParts: string[] = ["trashed = false"];
  
  if (options.folderId) {
    queryParts.push(`'${options.folderId}' in parents`);
  }
  
  if (options.mimeType) {
    queryParts.push(`mimeType = '${options.mimeType}'`);
  }
  
  if (options.query) {
    queryParts.push(options.query);
  }

  const query = queryParts.join(' and ');

  // Execute list request
  const response = await drive.files.list({
    q: query,
    pageSize: options.pageSize || 100,
    pageToken: options.pageToken,
    fields: 'nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime, webViewLink, iconLink, thumbnailLink, parents)',
    orderBy: 'modifiedTime desc',
  });

  return {
    files: (response.data.files || []) as DriveFile[],
    nextPageToken: response.data.nextPageToken || undefined,
  };
}

/**
 * Get file metadata from Google Drive
 * 
 * @param fileId - Google Drive file ID
 * @returns Promise resolving to file metadata
 */
export async function getFileMetadata(fileId: string): Promise<DriveFileMetadata> {
  const drive = getDriveClient();

  const response = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, modifiedTime, createdTime, webViewLink, parents',
  });

  return response.data as DriveFileMetadata;
}

/**
 * Download file from Google Drive to local path
 * 
 * @param fileId - Google Drive file ID
 * @param destPath - Destination path for downloaded file
 * @returns Promise resolving to downloaded file path
 */
export async function downloadFile(fileId: string, destPath: string): Promise<string> {
  const drive = getDriveClient();

  const response = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  return new Promise((resolve, reject) => {
    const dest = createWriteStream(destPath);
    
    response.data
      .on('error', reject)
      .pipe(dest)
      .on('error', reject)
      .on('finish', () => resolve(destPath));
  });
}

/**
 * Upload file to Google Drive
 * 
 * @param filePath - Path to local file
 * @param options - Upload options (name, folderId, mimeType, replaceFileId)
 * @returns Promise resolving to uploaded file metadata
 */
export async function uploadFile(
  filePath: string,
  options: UploadOptions = {}
): Promise<DriveFileMetadata> {
  const drive = getDriveClient();

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const media = {
    mimeType: options.mimeType || 'application/octet-stream',
    body: createReadStream(filePath),
  };

  // If replaceFileId is provided, update existing file
  if (options.replaceFileId) {
    const response = await drive.files.update({
      fileId: options.replaceFileId,
      media,
      fields: 'id, name, mimeType, size, modifiedTime, createdTime, webViewLink, parents',
    });

    return response.data as DriveFileMetadata;
  }

  // Otherwise create new file
  const fileMetadata: any = {
    name: options.name || filePath.split('/').pop() || 'untitled',
  };

  if (options.folderId) {
    fileMetadata.parents = [options.folderId];
  }

  const response = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id, name, mimeType, size, modifiedTime, createdTime, webViewLink, parents',
  });

  return response.data as DriveFileMetadata;
}

/**
 * Delete file from Google Drive
 * 
 * @param fileId - Google Drive file ID
 * @returns Promise resolving when file is deleted
 */
export async function deleteFile(fileId: string): Promise<void> {
  const drive = getDriveClient();
  await drive.files.delete({ fileId });
}

// ── Webhook Management ───────────────────────────────────────

/**
 * Create webhook for file change notifications
 * 
 * @param fileId - Google Drive file ID to monitor
 * @param callbackUrl - URL to receive webhook notifications (optional, uses env var)
 * @returns Promise resolving to webhook details
 */
export async function createWebhook(
  fileId: string,
  callbackUrl?: string
): Promise<DriveWebhook> {
  const drive = getDriveClient();
  const url = callbackUrl || WEBHOOK_URL;

  if (!url) {
    throw new Error('Webhook URL not configured. Set GOOGLE_DRIVE_WEBHOOK_URL environment variable.');
  }

  const channelId = uuidv4();
  const expiration = Date.now() + (24 * 60 * 60 * 1000); // 24 hours from now

  const response = await drive.files.watch({
    fileId,
    requestBody: {
      id: channelId,
      type: 'web_hook',
      address: url,
      expiration: expiration.toString(),
    },
  });

  return {
    id: response.data.id!,
    resourceId: response.data.resourceId!,
    resourceUri: response.data.resourceUri!,
    kind: response.data.kind!,
    expiration: response.data.expiration!,
  };
}

/**
 * Stop webhook channel
 * 
 * @param channelId - Webhook channel ID
 * @param resourceId - Webhook resource ID
 * @returns Promise resolving when webhook is stopped
 */
export async function stopWebhook(channelId: string, resourceId: string): Promise<void> {
  const drive = getDriveClient();

  await drive.channels.stop({
    requestBody: {
      id: channelId,
      resourceId: resourceId,
    },
  });
}

/**
 * Verify webhook notification signature
 * 
 * @param headers - Request headers from webhook
 * @param body - Request body from webhook
 * @returns True if signature is valid
 */
export function verifyWebhookSignature(
  headers: Record<string, string | string[] | undefined>,
  body: any
): boolean {
  // Google Drive webhooks don't use HMAC signatures like GitHub
  // Instead, verify the channel ID and resource state are present
  const channelId = headers['x-goog-channel-id'];
  const resourceState = headers['x-goog-resource-state'];
  const resourceId = headers['x-goog-resource-id'];

  return !!(channelId && resourceState && resourceId);
}

/**
 * Renew webhook before expiration
 * 
 * @param fileId - Google Drive file ID
 * @param oldChannelId - Old channel ID to stop
 * @param oldResourceId - Old resource ID
 * @param callbackUrl - URL to receive webhook notifications (optional)
 * @returns Promise resolving to new webhook details
 */
export async function renewWebhook(
  fileId: string,
  oldChannelId: string,
  oldResourceId: string,
  callbackUrl?: string
): Promise<DriveWebhook> {
  // Stop old webhook
  try {
    await stopWebhook(oldChannelId, oldResourceId);
  } catch (error) {
    console.warn(`[googleDrive] Failed to stop old webhook: ${error}`);
  }

  // Create new webhook
  return createWebhook(fileId, callbackUrl);
}

// ── Utility Functions ────────────────────────────────────────

/**
 * Build web view URL for a file
 * 
 * @param fileId - Google Drive file ID
 * @returns Web view URL
 */
export function buildFileUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

/**
 * Extract file ID from Google Drive URL
 * 
 * @param url - Google Drive URL
 * @returns File ID or null if not found
 */
export function extractFileIdFromUrl(url: string): string | null {
  const patterns = [
    /\/file\/d\/([^\/]+)/,
    /id=([^&]+)/,
    /\/d\/([^\/]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return match[1];
    }
  }

  return null;
}

// ── Exports ──────────────────────────────────────────────────

export default {
  initDriveClient,
  listFiles,
  getFileMetadata,
  downloadFile,
  uploadFile,
  deleteFile,
  createWebhook,
  stopWebhook,
  renewWebhook,
  verifyWebhookSignature,
  buildFileUrl,
  extractFileIdFromUrl,
};
