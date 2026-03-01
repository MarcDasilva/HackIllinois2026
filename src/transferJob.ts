/**
 * src/transferJob.ts
 *
 * Drive transfer execution logic.
 *
 * Responsibilities:
 *   - Given a document ID and a target folder, move the associated Drive file.
 *   - Manage the `transfer_status` lifecycle on the `documents` row:
 *       none → pending  (set by POST /transfer)
 *       pending → in_progress → done | error  (managed here)
 *   - Update `drive_folder_id`, `mime_type`, `transferred_at` on success.
 *   - Write `transfer_error` on failure (without throwing — callers get a result).
 *
 * Used by:
 *   - src/server.ts (POST /transfer trigger)
 *
 * The entropy oracle (src/index.ts) requires zero changes — it will
 * automatically include updated document IDs in the next tick's hash.
 */

import { getSupabaseClient } from "./supabase";
import { moveFile, getFile } from "./googleDrive";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TransferRequest {
  /** UUID of the row in `documents` to transfer. */
  documentId: string;

  /** Drive folder ID to move the file into. */
  targetFolderId: string;

  /** Supabase user ID who owns the Google Drive integration. */
  userId: string;
}

export type TransferStatus = "none" | "pending" | "in_progress" | "done" | "error";

export interface TransferResult {
  documentId: string;
  status: TransferStatus;
  /** Set on success — the new Drive folder ID. */
  newFolderId?: string;
  /** Set on success — when the transfer completed. */
  transferredAt?: string;
  /** Set on failure — human-readable reason. */
  error?: string;
}

// ─── Internal Supabase row shape ──────────────────────────────────────────────

interface DocumentRow {
  id: string;
  drive_file_id: string | null;
  drive_folder_id: string | null;
  mime_type: string | null;
  transfer_status: TransferStatus;
  transfer_target_folder_id: string | null;
}

// ─── Status helpers ───────────────────────────────────────────────────────────

async function setStatus(
  documentId: string,
  status: TransferStatus,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase
    .from("documents")
    .update({ transfer_status: status, ...extra })
    .eq("id", documentId);

  if (error) {
    console.error(
      `[transferJob] Failed to set status "${status}" on document ${documentId}: ${error.message}`
    );
  }
}

// ─── Main transfer executor ───────────────────────────────────────────────────

/**
 * Execute a Drive file transfer for a document.
 *
 * Steps:
 *   1. Load the document row from Supabase (validate it has a drive_file_id).
 *   2. Mark status = 'in_progress'.
 *   3. Call Drive API to move the file.
 *   4. Update the document row with new folder + status = 'done'.
 *   5. On any error: set status = 'error' and persist the error message.
 *
 * Always resolves (never rejects) — the result's `status` field indicates success/failure.
 */
export async function executeTransfer(req: TransferRequest): Promise<TransferResult> {
  const { documentId, targetFolderId, userId } = req;
  const supabase = getSupabaseClient();

  console.log(
    `[transferJob] Starting transfer — doc=${documentId}  target=${targetFolderId}  user=${userId}`
  );

  // ── 1. Load document row ──────────────────────────────────────────────────
  const { data, error: fetchError } = await supabase
    .from("documents")
    .select("id, drive_file_id, drive_folder_id, mime_type, transfer_status, transfer_target_folder_id")
    .eq("id", documentId)
    .single();

  if (fetchError || !data) {
    const msg = fetchError?.message ?? "Row not found";
    console.error(`[transferJob] Cannot load document ${documentId}: ${msg}`);
    return { documentId, status: "error", error: `Document not found: ${msg}` };
  }

  const doc = data as unknown as DocumentRow;

  if (!doc.drive_file_id) {
    const msg = "Document has no drive_file_id — cannot transfer.";
    console.error(`[transferJob] ${msg}`);
    await setStatus(documentId, "error", { transfer_error: msg });
    return { documentId, status: "error", error: msg };
  }

  // Guard against concurrent runs on the same document.
  if (doc.transfer_status === "in_progress") {
    const msg = "Transfer already in_progress — skipping duplicate.";
    console.warn(`[transferJob] ${msg}`);
    return { documentId, status: "in_progress", error: msg };
  }

  const currentFolderId = doc.drive_folder_id;

  if (!currentFolderId) {
    // If we don't have the current folder stored, fetch it from Drive.
    try {
      const meta = await getFile(userId, doc.drive_file_id);
      const parentId = meta.parents[0] ?? null;

      if (!parentId) {
        const msg = "Drive file has no parent folder — cannot determine removeParents.";
        await setStatus(documentId, "error", { transfer_error: msg });
        return { documentId, status: "error", error: msg };
      }

      // Persist the discovered folder so future runs don't need this lookup.
      await supabase
        .from("documents")
        .update({ drive_folder_id: parentId, mime_type: meta.mimeType })
        .eq("id", documentId);

      doc.drive_folder_id = parentId;
      doc.mime_type = meta.mimeType;
    } catch (err) {
      const msg = `Failed to fetch Drive metadata: ${String(err)}`;
      await setStatus(documentId, "error", { transfer_error: msg });
      return { documentId, status: "error", error: msg };
    }
  }

  // ── 2. Mark in_progress ───────────────────────────────────────────────────
  await setStatus(documentId, "in_progress", {
    transfer_target_folder_id: targetFolderId,
    transfer_error: null,
  });

  // ── 3. Call Drive API ─────────────────────────────────────────────────────
  try {
    const movedFile = await moveFile(
      userId,
      doc.drive_file_id,
      targetFolderId,
      doc.drive_folder_id!
    );

    const transferredAt = new Date().toISOString();

    // ── 4. Update document row on success ─────────────────────────────────
    const { error: updateError } = await supabase
      .from("documents")
      .update({
        drive_folder_id: targetFolderId,
        mime_type: movedFile.mimeType || doc.mime_type,
        transfer_status: "done",
        transfer_target_folder_id: null,
        transfer_error: null,
        transferred_at: transferredAt,
      })
      .eq("id", documentId);

    if (updateError) {
      // Transfer succeeded in Drive but we failed to persist the result.
      // Log it — the file is moved, but our DB is stale. Operator must reconcile.
      console.error(
        `[transferJob] Transfer succeeded in Drive but Supabase update failed: ${updateError.message}`
      );
    }

    console.log(
      `[transferJob] Transfer complete — doc=${documentId}  newFolder=${targetFolderId}  at=${transferredAt}`
    );

    return {
      documentId,
      status: "done",
      newFolderId: targetFolderId,
      transferredAt,
    };
  } catch (err) {
    // ── 5. Handle Drive API failure ────────────────────────────────────────
    const msg = String(err);
    console.error(`[transferJob] Drive API error for doc ${documentId}: ${msg}`);

    await setStatus(documentId, "error", {
      transfer_error: msg,
      transfer_target_folder_id: null,
    });

    return { documentId, status: "error", error: msg };
  }
}

// ─── Batch: process all pending transfers ────────────────────────────────────

/**
 * Query Supabase for all documents with transfer_status = 'pending'
 * and execute each transfer sequentially.
 *
 * Useful for a background sweep or a cron-style retry mechanism.
 * The HTTP server calls executeTransfer directly for single transfers;
 * this function is for bulk processing.
 */
export async function processPendingTransfers(userId: string): Promise<TransferResult[]> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("documents")
    .select("id, transfer_target_folder_id")
    .eq("transfer_status", "pending")
    .not("transfer_target_folder_id", "is", null)
    .limit(50);

  if (error) {
    console.error(`[transferJob] Failed to query pending transfers: ${error.message}`);
    return [];
  }

  if (!data || data.length === 0) {
    console.log("[transferJob] No pending transfers.");
    return [];
  }

  console.log(`[transferJob] Processing ${data.length} pending transfer(s)…`);

  const results: TransferResult[] = [];

  for (const row of data as Array<{ id: string; transfer_target_folder_id: string }>) {
    const result = await executeTransfer({
      documentId: row.id,
      targetFolderId: row.transfer_target_folder_id,
      userId,
    });
    results.push(result);
  }

  return results;
}
