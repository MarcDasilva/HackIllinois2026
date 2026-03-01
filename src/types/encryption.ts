/**
 * TypeScript interfaces for encryption system
 */

export type EncryptionStatus = 'pending' | 'processing' | 'encrypted' | 'failed';
export type EncryptionMethod = 'veildoc_full' | 'veildoc_pattern';
export type EncryptionMode = 'full' | 'pattern';

export interface EncryptedDocument {
  id: string;
  title: string;
  content?: string;
  owner_id?: string;
  metadata: Record<string, any>;
  status: string;
  created_at: string;
  updated_at: string;
  
  // Encryption-related fields
  google_drive_id?: string;
  google_drive_name?: string;
  encryption_status?: EncryptionStatus;
  encryption_method?: EncryptionMethod;
  encryption_enabled?: boolean;
  webhook_channel_id?: string | null;
  webhook_resource_id?: string | null;
  webhook_expiration?: string | null;
  last_encrypted_at?: string;
  drive_modified_time?: string;
  original_drive_url?: string;
  encrypted_drive_url?: string;
  sidecar_json?: Record<string, any>;
  error_message?: string | null;
}

export interface EncryptionJob {
  id: string;
  fileIds: string[];
  mode: EncryptionMode;
  replaceOriginal: boolean;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  progress: {
    total: number;
    completed: number;
    failed: number;
  };
  results: EncryptionJobResult[];
  createdAt: Date;
  updatedAt: Date;
}

export interface EncryptionJobResult {
  fileId: string;
  fileName: string;
  status: 'success' | 'failed';
  error?: string;
  documentId?: string;
}

export interface WebhookNotification {
  resourceState: 'sync' | 'update' | 'change' | 'trash' | 'untrash';
  resourceId: string;
  resourceUri: string;
  channelId: string;
  channelToken?: string;
  channelExpiration?: string;
  messageNumber?: string;
  changed?: string;
}
