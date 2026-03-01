"use client";

/**
 * app/page.tsx
 *
 * Main dashboard page.
 *
 * Layout:
 *   Header — logo + network badge
 *   Two-column grid:
 *     Left  — SolanaTransfer (wallet connect + send SOL)
 *     Right — DriveTransfer  (move Drive file → Supabase → on-chain)
 *   Activity feed — most recent transfer events this session
 *   How-it-connects explainer
 */

import { useState } from "react";
import SolanaTransfer from "./components/SolanaTransfer";
import DriveTransfer from "./components/DriveTransfer";

interface ActivityItem {
  id: number;
  kind: "solana" | "drive";
  label: string;
  detail: string;
  ts: string;
  href?: string;
}

const CLUSTER = process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet";
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3000";

function explorerUrl(sig: string) {
  return `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
}

let nextId = 1;

export default function Home() {
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  function addActivity(item: Omit<ActivityItem, "id" | "ts">) {
    setActivity((prev) => [
      { ...item, id: nextId++, ts: new Date().toLocaleTimeString() },
      ...prev.slice(0, 9),
    ]);
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header className="border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl font-bold tracking-tight">LAVA</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400 hidden sm:block">
              Entropy Oracle
            </span>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 text-xs font-medium px-3 py-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            {CLUSTER}
          </span>
        </div>
      </header>

      {/* ── Main content ─────────────────────────────────────────────────────── */}
      <main className="max-w-5xl mx-auto px-4 py-8 space-y-8">

        <p className="text-center text-sm text-zinc-500 dark:text-zinc-400">
          Every SOL transfer and Drive file move is stamped into the entropy oracle&apos;s next on-chain commit.
        </p>

        {/* ── Two-column panel grid ─────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <SolanaTransfer
            onTransferComplete={(sig) =>
              addActivity({
                kind: "solana",
                label: "SOL sent",
                detail: `${sig.slice(0, 8)}…${sig.slice(-6)}`,
                href: explorerUrl(sig),
              })
            }
          />

          <DriveTransfer
            apiBase={API_BASE}
            onTransferComplete={(result) =>
              addActivity({
                kind: "drive",
                label: "Drive file moved",
                detail: result.newFolderId
                  ? `→ ${result.newFolderId.slice(0, 12)}…`
                  : result.documentId,
              })
            }
          />
        </div>

        {/* ── Activity feed ─────────────────────────────────────────────────── */}
        {activity.length > 0 && (
          <div className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 shadow-sm">
            <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-4">
              Session activity
            </h3>
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {activity.map((item) => (
                <li key={item.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <span
                    className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                      item.kind === "solana"
                        ? "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-400"
                        : "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-400"
                    }`}
                  >
                    {item.kind === "solana" ? "◎" : "D"}
                  </span>

                  <div className="flex-1 min-w-0">
                    <span className="font-medium">{item.label}</span>
                    {item.href ? (
                      <a
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-2 font-mono text-xs text-zinc-500 hover:text-violet-600 dark:hover:text-violet-400 underline underline-offset-2"
                      >
                        {item.detail}
                      </a>
                    ) : (
                      <span className="ml-2 font-mono text-xs text-zinc-500">
                        {item.detail}
                      </span>
                    )}
                  </div>

                  <span className="shrink-0 text-xs text-zinc-400">{item.ts}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* ── How it connects ───────────────────────────────────────────────── */}
        <div className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-4">
            How it all connects
          </h3>
          <ol className="space-y-3 text-sm text-zinc-600 dark:text-zinc-400">
            <li className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-400 text-xs font-bold flex items-center justify-center">
                1
              </span>
              <span>
                <strong className="text-zinc-800 dark:text-zinc-200">Solana Transfer</strong>{" "}
                — signs and sends SOL directly from your browser wallet to any address on {CLUSTER}.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-400 text-xs font-bold flex items-center justify-center">
                2
              </span>
              <span>
                <strong className="text-zinc-800 dark:text-zinc-200">Drive Transfer</strong>{" "}
                — calls <code className="font-mono text-xs">POST /transfer</code> on the backend, which moves the file in Google Drive and updates the <code className="font-mono text-xs">documents</code> row in Supabase.
              </span>
            </li>
            <li className="flex gap-3">
              <span className="shrink-0 w-6 h-6 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 text-xs font-bold flex items-center justify-center">
                3
              </span>
              <span>
                <strong className="text-zinc-800 dark:text-zinc-200">Entropy Oracle</strong>{" "}
                — every 5 seconds reads all document IDs from Supabase, hashes them with the current Solana slot + blockhash + 30 token account states, and commits the result on-chain via the SPL Memo program.
              </span>
            </li>
          </ol>
        </div>
      </main>
    </div>
  );
}
