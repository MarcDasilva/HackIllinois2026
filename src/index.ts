/**
 * src/index.ts
 *
 * Main entry point for the LAVA entropy oracle.
 *
 * Loop (every ENTROPY_INTERVAL_MS):
 *   1. Fetch Supabase document IDs + Solana snapshot in parallel
 *   2. Compute SHA3-256 entropy seed (tokens + docs + slot + blockhash)
 *   3. Commit on-chain via Memo program (or skip if DRY_RUN=true)
 *   4. Persist result to data/commits.jsonl
 *   5. Sleep, repeat
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

import { createConnection, loadKeypair, getBalanceSol } from "./solana";
import { loadTokenAccounts, fetchSnapshot } from "./snapshot";
import { computeEntropy } from "./entropy";
import { sendCommit } from "./memoCommit";
import { fetchDocumentIds, validateSupabaseConnection } from "./supabase";

// ─── Constants ────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), "data");
const COMMITS_FILE = path.join(DATA_DIR, "commits.jsonl");

// ─── Persistence types ────────────────────────────────────────────────────────

interface CommitRecord {
  ts: string;
  slot: number;
  blockhash: string;
  tokens_state_hash: string;
  docs_hash: string;
  doc_count: number;
  entropy_seed: string;
  signature: string | null; // null in dry-run mode or on tx failure
}

// ─── Startup ──────────────────────────────────────────────────────────────────

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`[index] Created data directory: ${DATA_DIR}`);
  }
}

function appendCommit(record: CommitRecord): void {
  fs.appendFileSync(COMMITS_FILE, JSON.stringify(record) + "\n", "utf8");
}

// ─── Single oracle tick ───────────────────────────────────────────────────────

async function runTick(
  connection: ReturnType<typeof createConnection>,
  payer: ReturnType<typeof loadKeypair>,
  tokenPubkeys: PublicKey[],
  dryRun: boolean
): Promise<void> {
  const tickStart = Date.now();

  // 1. Fetch Supabase doc IDs and Solana snapshot in parallel
  console.log("\n[tick] Fetching Supabase IDs + Solana snapshot in parallel…");

  const [docResult, snapshot] = await Promise.all([
    fetchDocumentIds().catch((err: unknown) => {
      // Non-fatal: log and continue with empty ID list so chain commits still work
      console.warn(`[tick] Supabase fetch failed (using empty list): ${String(err)}`);
      return { ids: [], table: "unknown", count: 0 };
    }),
    fetchSnapshot(connection, tokenPubkeys),
  ]);

  console.log(
    `[tick] Snapshot  — slot=${snapshot.slot}  blockhash=${snapshot.blockhash}`
  );
  console.log(
    `[tick] Supabase  — table="${docResult.table}"  ids=${docResult.count}`
  );

  // 2. Compute entropy (tokens + docs + slot + blockhash)
  const { tokens_state_hash, docs_hash, entropy_seed, doc_count } =
    computeEntropy(snapshot, docResult.ids);

  const ts = new Date().toISOString();
  console.log(`[tick] ts                : ${ts}`);
  console.log(`[tick] slot              : ${snapshot.slot}`);
  console.log(`[tick] doc_count         : ${doc_count}`);
  console.log(`[tick] tokens_state_hash : ${tokens_state_hash}`);
  console.log(`[tick] docs_hash         : ${docs_hash}`);
  console.log(`[tick] entropy_seed      : ${entropy_seed}`);

  // 3. On-chain commit (or dry-run)
  let signature: string | null = null;

  if (dryRun) {
    console.log("[tick] DRY_RUN=true — skipping on-chain commit.");
  } else {
    console.log("[tick] Submitting commit transaction…");
    try {
      const result = await sendCommit(connection, payer, {
        slot: snapshot.slot,
        blockhash: snapshot.blockhash,
        tokens_state_hash,
        docs_hash,
        doc_count,
        entropy_seed,
      });
      signature = result.signature;
      console.log(`[tick] Confirmed! Signature: ${signature}`);
      console.log(`[tick] Explorer  : ${result.explorerUrl}`);
    } catch (err) {
      console.error(`[tick] Failed to commit transaction: ${String(err)}`);
    }
  }

  // 4. Persist
  const record: CommitRecord = {
    ts,
    slot: snapshot.slot,
    blockhash: snapshot.blockhash,
    tokens_state_hash,
    docs_hash,
    doc_count,
    entropy_seed,
    signature,
  };
  appendCommit(record);

  const elapsed = Date.now() - tickStart;
  console.log(`[tick] Persisted to ${COMMITS_FILE}  (${elapsed}ms total)`);
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const intervalMs = parseInt(process.env.ENTROPY_INTERVAL_MS ?? "5000", 10);
  if (isNaN(intervalMs) || intervalMs < 1000) {
    throw new Error(
      `ENTROPY_INTERVAL_MS must be an integer >= 1000; got "${process.env.ENTROPY_INTERVAL_MS}"`
    );
  }

  const dryRun = (process.env.DRY_RUN ?? "false").toLowerCase() === "true";

  ensureDataDir();

  const connection = createConnection();
  const payer = loadKeypair();
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
  const balanceSol = await getBalanceSol(connection, payer.publicKey);

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  LAVA Entropy Oracle — Solana Devnet + Supabase");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  RPC URL    : ${rpcUrl}`);
  console.log(`  Payer      : ${payer.publicKey.toBase58()}`);
  console.log(`  Balance    : ${balanceSol.toFixed(4)} SOL`);
  console.log(`  Interval   : ${intervalMs}ms`);
  console.log(`  Dry-run    : ${dryRun}`);
  console.log(`  Supabase   : ${process.env.SUPABASE_URL ?? "(not set)"}`);
  console.log(`  Table      : ${process.env.SUPABASE_TABLE ?? "documents"}`);
  console.log(`  Commits    : ${COMMITS_FILE}`);
  console.log("═══════════════════════════════════════════════════════════════");

  if (!dryRun && balanceSol < 0.01) {
    console.warn(
      `[index] WARNING: Balance is low (${balanceSol} SOL). ` +
        "Run: solana airdrop 1 --url devnet"
    );
  }

  // Validate Supabase connection at startup (fail fast if misconfigured)
  await validateSupabaseConnection();

  const tokenPubkeys = await loadTokenAccounts();
  console.log(`[index] Loaded ${tokenPubkeys.length} token accounts.`);

  let running = true;
  const shutdown = (): void => {
    console.log("\n[index] Shutting down gracefully…");
    running = false;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[index] Starting oracle loop. Press Ctrl+C to stop.\n");

  while (running) {
    try {
      await runTick(connection, payer, tokenPubkeys, dryRun);
    } catch (err) {
      console.error(`[index] Tick error (will retry next interval): ${String(err)}`);
    }

    if (!running) break;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }

  console.log("[index] Oracle stopped.");
}

main().catch((err) => {
  console.error("[index] Fatal error:", String(err));
  process.exit(1);
});
