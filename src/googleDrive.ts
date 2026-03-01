/**
 * src/googleDrive.ts
 *
 * Google Drive API v3 wrapper.
 *
 * Responsibilities:
 *   - Build an authenticated Drive client from a user's stored OAuth tokens.
 *   - Automatically refresh the access_token when it is expired/near-expiry,
 *     and persist the new token back to Supabase.
 *   - Expose three operations needed by the transfer job:
 *       listFiles(folderId)  — list all files in a Drive folder
 *       moveFile(fileId, targetFolderId, currentFolderId) — move (re-parent) a file
 *       getFile(fileId)      — fetch file metadata
 *
 * OAuth flow (per-user):
 *   - Client ID + Secret live in env vars (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).
 *   - Per-user access_token + refresh_token are stored in the `user_integrations`
 *     Supabase table and loaded at call time.
 *   - The googleapis library handles token expiry detection; we write the new
 *     token back to Supabase via the `onTokenRefresh` callback.
 *
 * Environment variables:
 *   GOOGLE_CLIENT_ID     — OAuth 2.0 client ID from Google Cloud Console
 *   GOOGLE_CLIENT_SECRET — OAuth 2.0 client secret
 *   GOOGLE_REDIRECT_URI  — Redirect URI registered in Google Cloud Console
 *                          (e.g. http://localhost:3000/oauth/callback)
 */

import { google, drive_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { getSupabaseClient } from "./supabase";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  webViewLink?: string;
  createdTime?: string;
  modifiedTime?: string;
}

export interface UserTokens {
  access_token: string;
  refresh_token: string;
  token_expires_at: string; // ISO timestamp
}

// ─── OAuth client factory ─────────────────────────────────────────────────────

function getOAuthConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || clientId.trim() === "") {
    throw new Error(
      "GOOGLE_CLIENT_ID is not set.\n" +
        "  Create an OAuth 2.0 client at: https://console.cloud.google.com/apis/credentials"
    );
  }
  if (!clientSecret || clientSecret.trim() === "") {
    throw new Error("GOOGLE_CLIENT_SECRET is not set.");
  }
  if (!redirectUri || redirectUri.trim() === "") {
    throw new Error(
      "GOOGLE_REDIRECT_URI is not set.\n" +
        "  Example: GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/callback"
    );
  }

  return { clientId, clientSecret, redirectUri };
}

/**
 * Build an OAuth2Client pre-loaded with a user's stored tokens.
 * Registers an on-refresh callback that persists the new token to Supabase.
 */
export function buildOAuthClient(
  tokens: UserTokens,
  userId: string
): OAuth2Client {
  const { clientId, clientSecret, redirectUri } = getOAuthConfig();

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  oauth2Client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: new Date(tokens.token_expires_at).getTime(),
  });

  // Whenever the library auto-refreshes the access_token, persist it back.
  oauth2Client.on("tokens", (newTokens) => {
    if (newTokens.access_token) {
      const expiresAt = newTokens.expiry_date
        ? new Date(newTokens.expiry_date).toISOString()
        : new Date(Date.now() + 3600 * 1000).toISOString(); // fallback: +1h

      persistTokens(userId, newTokens.access_token, expiresAt).catch((err) => {
        console.error(`[googleDrive] Failed to persist refreshed token for user ${userId}: ${String(err)}`);
      });
    }
  });

  return oauth2Client;
}

/**
 * Generate the Google OAuth consent URL. Redirect the user to this URL
 * so they can grant Drive access; Google will send them back to REDIRECT_URI
 * with a `code` query parameter.
 */
export function getAuthUrl(): string {
  const { clientId, clientSecret, redirectUri } = getOAuthConfig();
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  return oauth2Client.generateAuthUrl({
    access_type: "offline",  // ensures a refresh_token is returned
    prompt: "consent",       // force consent screen so refresh_token is always returned
    scope: [
      "https://www.googleapis.com/auth/drive",           // full Drive access
      "https://www.googleapis.com/auth/userinfo.email",  // for storing google_email
    ],
  });
}

/**
 * Exchange an authorization code (from the OAuth callback) for tokens,
 * then store them in the `user_integrations` table.
 */
export async function exchangeCodeAndStore(
  code: string,
  userId: string
): Promise<void> {
  const { clientId, clientSecret, redirectUri } = getOAuthConfig();
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error(
      "OAuth token exchange did not return access_token or refresh_token. " +
        "Ensure prompt=consent and access_type=offline are set in the auth URL."
    );
  }

  const expiresAt = tokens.expiry_date
    ? new Date(tokens.expiry_date).toISOString()
    : new Date(Date.now() + 3600 * 1000).toISOString();

  // Fetch user's email for display purposes.
  oauth2Client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const { data: userInfo } = await oauth2.userinfo.get();

  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from("user_integrations")
    .upsert(
      {
        user_id: userId,
        provider: "google_drive",
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_expires_at: expiresAt,
        google_email: userInfo.email ?? null,
      },
      { onConflict: "user_id,provider" }
    );

  if (error) {
    throw new Error(`Failed to store OAuth tokens in Supabase: ${error.message}`);
  }

  console.log(`[googleDrive] Stored tokens for user ${userId} (${userInfo.email ?? "unknown email"})`);
}

// ─── Token persistence helper ─────────────────────────────────────────────────

async function persistTokens(
  userId: string,
  accessToken: string,
  expiresAt: string
): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from("user_integrations")
    .update({ access_token: accessToken, token_expires_at: expiresAt })
    .eq("user_id", userId)
    .eq("provider", "google_drive");

  if (error) {
    throw new Error(`persistTokens failed: ${error.message}`);
  }
}

// ─── Load tokens from Supabase ────────────────────────────────────────────────

/**
 * Load a user's stored OAuth tokens from Supabase.
 * Throws if the user has not connected their Google Drive.
 */
export async function loadUserTokens(userId: string): Promise<UserTokens> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("user_integrations")
    .select("access_token, refresh_token, token_expires_at")
    .eq("user_id", userId)
    .eq("provider", "google_drive")
    .single();

  if (error || !data) {
    throw new Error(
      `No Google Drive integration found for user ${userId}. ` +
        "Have them connect at GET /oauth/google"
    );
  }

  return {
    access_token: (data as Record<string, string>).access_token,
    refresh_token: (data as Record<string, string>).refresh_token,
    token_expires_at: (data as Record<string, string>).token_expires_at,
  };
}

// ─── Drive operations ─────────────────────────────────────────────────────────

/**
 * Build a Drive v3 client from a user's stored OAuth tokens.
 */
function buildDriveClient(tokens: UserTokens, userId: string): drive_v3.Drive {
  const auth = buildOAuthClient(tokens, userId);
  return google.drive({ version: "v3", auth });
}

/**
 * List all files in a Drive folder (non-recursive).
 * Returns metadata for each file.
 */
export async function listFiles(
  userId: string,
  folderId: string
): Promise<DriveFileMetadata[]> {
  const tokens = await loadUserTokens(userId);
  const drive = buildDriveClient(tokens, userId);

  const files: DriveFileMetadata[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, parents, webViewLink, createdTime, modifiedTime)",
      pageSize: 100,
      pageToken,
    });

    const page = res.data;

    for (const f of page.files ?? []) {
      files.push({
        id: f.id ?? "",
        name: f.name ?? "",
        mimeType: f.mimeType ?? "",
        parents: f.parents ?? [],
        webViewLink: f.webViewLink ?? undefined,
        createdTime: f.createdTime ?? undefined,
        modifiedTime: f.modifiedTime ?? undefined,
      });
    }

    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}

/**
 * Fetch metadata for a single Drive file.
 */
export async function getFile(
  userId: string,
  fileId: string
): Promise<DriveFileMetadata> {
  const tokens = await loadUserTokens(userId);
  const drive = buildDriveClient(tokens, userId);

  const res = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, parents, webViewLink, createdTime, modifiedTime",
  });

  const f = res.data;

  return {
    id: f.id ?? "",
    name: f.name ?? "",
    mimeType: f.mimeType ?? "",
    parents: f.parents ?? [],
    webViewLink: f.webViewLink ?? undefined,
    createdTime: f.createdTime ?? undefined,
    modifiedTime: f.modifiedTime ?? undefined,
  };
}

/**
 * Move a Drive file to a different folder by updating its parent.
 *
 * Google Drive "move" = add new parent + remove old parent in a single PATCH.
 * This preserves the file ID (no copy created).
 *
 * @param userId           — Supabase user ID (to load tokens)
 * @param fileId           — Drive file ID to move
 * @param targetFolderId   — Destination folder ID
 * @param currentFolderId  — Current/source folder ID (needed to remove old parent)
 */
export async function moveFile(
  userId: string,
  fileId: string,
  targetFolderId: string,
  currentFolderId: string
): Promise<DriveFileMetadata> {
  const tokens = await loadUserTokens(userId);
  const drive = buildDriveClient(tokens, userId);

  const res = await drive.files.update({
    fileId,
    addParents: targetFolderId,
    removeParents: currentFolderId,
    fields: "id, name, mimeType, parents, webViewLink, createdTime, modifiedTime",
  });

  const f = res.data;

  return {
    id: f.id ?? "",
    name: f.name ?? "",
    mimeType: f.mimeType ?? "",
    parents: f.parents ?? [],
    webViewLink: f.webViewLink ?? undefined,
    createdTime: f.createdTime ?? undefined,
    modifiedTime: f.modifiedTime ?? undefined,
  };
}
