"use client";

/**
 * DriveTransfer.tsx
 *
 * UI component: transfer a Google Drive file to a different folder,
 * tracked in Supabase and stamped into the entropy oracle's on-chain hash.
 *
 * Features:
 *  - Input: document UUID (Supabase documents.id)
 *  - Input: target Drive folder ID
 *  - Input: user UUID (who owns the Drive token)
 *  - Shows transfer_status lifecycle with visual indicators
 *  - On success, shows the new folder ID and a timestamp
 *  - All API calls go to the backend Express server (default: localhost:3000)
 *
 * Props:
 *  - apiBase?: string  — base URL of the backend server (default: http://localhost:3000)
 *  - onTransferComplete?: (result: TransferResult) => void
 */

import { useState, useCallback } from "react";

interface TransferResult {
  documentId: string;
  status: "none" | "pending" | "in_progress" | "done" | "error";
  newFolderId?: string;
  transferredAt?: string;
  error?: string;
}

interface Props {
  apiBase?: string;
  onTransferComplete?: (result: TransferResult) => void;
}

type FormStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; result: TransferResult }
  | { kind: "error"; message: string };

function StatusBadge({ status }: { status: TransferResult["status"] }) {
  const map: Record<TransferResult["status"], { label: string; classes: string }> = {
    none:        { label: "None",        classes: "bg-zinc-100 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400" },
    pending:     { label: "Pending",     classes: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-400" },
    in_progress: { label: "In Progress", classes: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400" },
    done:        { label: "Done",        classes: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400" },
    error:       { label: "Error",       classes: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400" },
  };

  const { label, classes } = map[status];

  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${classes}`}>
      {label}
    </span>
  );
}

export default function DriveTransfer({
  apiBase = "http://localhost:3000",
  onTransferComplete,
}: Props) {
  const [documentId, setDocumentId] = useState("");
  const [targetFolderId, setTargetFolderId] = useState("");
  const [userId, setUserId] = useState("");
  const [formStatus, setFormStatus] = useState<FormStatus>({ kind: "idle" });

  const handleTransfer = useCallback(async () => {
    // ── Validate ────────────────────────────────────────────────────────────
    if (!documentId.trim() || !targetFolderId.trim() || !userId.trim()) {
      setFormStatus({
        kind: "error",
        message: "All three fields are required.",
      });
      return;
    }

    setFormStatus({ kind: "loading" });

    try {
      const res = await fetch(`${apiBase}/transfer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document_id: documentId.trim(),
          target_folder_id: targetFolderId.trim(),
          user_id: userId.trim(),
        }),
      });

      const data = (await res.json()) as TransferResult;

      if (data.status === "done") {
        setFormStatus({ kind: "success", result: data });
        onTransferComplete?.(data);
      } else {
        setFormStatus({
          kind: "error",
          message: data.error ?? `Transfer failed with status: ${data.status}`,
        });
      }
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Could not reach the backend server.";
      setFormStatus({ kind: "error", message: msg });
    }
  }, [documentId, targetFolderId, userId, apiBase, onTransferComplete]);

  const reset = () => {
    setFormStatus({ kind: "idle" });
    setDocumentId("");
    setTargetFolderId("");
    setUserId("");
  };

  const isLoading = formStatus.kind === "loading";

  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 shadow-sm space-y-5">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Drive Transfer
        </h2>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
          Move a Google Drive file · state tracked in Supabase · hashed on-chain
        </p>
      </div>

      {/* How it works */}
      <div className="rounded-lg bg-zinc-50 dark:bg-zinc-800 px-4 py-3 text-xs text-zinc-600 dark:text-zinc-400 space-y-1">
        <p className="font-medium text-zinc-700 dark:text-zinc-300">How it works</p>
        <p>1. Enter the Supabase document UUID, the destination Drive folder ID, and your user UUID.</p>
        <p>2. The backend moves the file in Drive and updates the <code className="font-mono">documents</code> row.</p>
        <p>3. The entropy oracle&apos;s next tick picks up the change and commits a new hash on-chain.</p>
      </div>

      {formStatus.kind !== "success" && (
        <div className="space-y-3">
          {/* Document ID */}
          <div>
            <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
              Document ID <span className="text-zinc-400">(Supabase UUID)</span>
            </label>
            <input
              type="text"
              placeholder="e.g. 3f5a2b1c-…"
              value={documentId}
              onChange={(e) => setDocumentId(e.target.value)}
              disabled={isLoading}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm font-mono placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
            />
          </div>

          {/* Target folder */}
          <div>
            <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
              Target Drive Folder ID
            </label>
            <input
              type="text"
              placeholder="e.g. 1BxiMVs0XRA5nFMdK…"
              value={targetFolderId}
              onChange={(e) => setTargetFolderId(e.target.value)}
              disabled={isLoading}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm font-mono placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
            />
          </div>

          {/* User ID */}
          <div>
            <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
              User ID <span className="text-zinc-400">(Supabase auth UUID)</span>
            </label>
            <input
              type="text"
              placeholder="e.g. a1b2c3d4-…"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              disabled={isLoading}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm font-mono placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
            />
          </div>

          {/* Error */}
          {formStatus.kind === "error" && (
            <p className="text-xs text-red-500 dark:text-red-400">
              {formStatus.message}
            </p>
          )}

          <button
            onClick={handleTransfer}
            disabled={isLoading || !documentId || !targetFolderId || !userId}
            className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 transition-colors"
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                Transferring…
              </span>
            ) : (
              "Transfer File"
            )}
          </button>
        </div>
      )}

      {/* Success */}
      {formStatus.kind === "success" && (
        <div className="space-y-3">
          <div className="rounded-lg border border-emerald-200 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/30 px-4 py-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-emerald-600 dark:text-emerald-400 text-lg">✓</span>
              <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                Transfer complete
              </p>
              <StatusBadge status="done" />
            </div>

            <dl className="text-xs space-y-1 text-zinc-600 dark:text-zinc-400">
              <div className="flex gap-2">
                <dt className="font-medium w-28 shrink-0">Document</dt>
                <dd className="font-mono truncate">{formStatus.result.documentId}</dd>
              </div>
              {formStatus.result.newFolderId && (
                <div className="flex gap-2">
                  <dt className="font-medium w-28 shrink-0">New folder</dt>
                  <dd className="font-mono truncate">{formStatus.result.newFolderId}</dd>
                </div>
              )}
              {formStatus.result.transferredAt && (
                <div className="flex gap-2">
                  <dt className="font-medium w-28 shrink-0">Completed at</dt>
                  <dd>{new Date(formStatus.result.transferredAt).toLocaleString()}</dd>
                </div>
              )}
            </dl>

            <p className="text-xs text-emerald-600 dark:text-emerald-400">
              The entropy oracle will include this change in its next on-chain commit.
            </p>
          </div>

          <button
            onClick={reset}
            className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold py-2.5 transition-colors"
          >
            Transfer another
          </button>
        </div>
      )}
    </div>
  );
}
