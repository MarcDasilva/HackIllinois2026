/**
 * TypeScript interfaces for Google Drive API
 */

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  createdTime: string;
  modifiedTime: string;
  webViewLink?: string;
  iconLink?: string;
  thumbnailLink?: string;
  parents?: string[];
  trashed?: boolean;
}

export interface DriveFileList {
  files: DriveFile[];
  nextPageToken?: string;
  incompleteSearch?: boolean;
}

export interface DriveWebhook {
  id: string;
  resourceId: string;
  resourceUri: string;
  kind: string;
  expiration: string;
}

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  size: string;
  modifiedTime: string;
  createdTime: string;
  webViewLink?: string;
  parents?: string[];
}

export interface UploadOptions {
  folderId?: string;
  name?: string;
  mimeType?: string;
  replaceFileId?: string;
}

export interface ListFilesOptions {
  folderId?: string;
  pageToken?: string;
  pageSize?: number;
  mimeType?: string;
  query?: string;
}
