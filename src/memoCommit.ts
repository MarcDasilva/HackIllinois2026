/**
 * src/memoCommit.ts
 *
 * Builds and sends a Solana transaction that commits entropy data via the
 * SPL Memo program (v2).
 *
 * ─── EXTENSION POINT ─────────────────────────────────────────────────────────
 * To swap Memo for a custom Anchor program later:
 *
 *   1. Replace `buildMemoInstruction()` with a function that constructs your
 *      Anchor instruction (using AnchorProvider + Program from @coral-xyz/anchor).
 *   2. Keep `buildCommitTransaction()` and `sendCommit()` as-is — they accept
 *      any TransactionInstruction.
 *   3. The CommitPayload interface stays the same, so index.ts and the JSONL
 *      persistence layer require zero changes.
 *
 * Example custom instruction builder (pseudo-code):
 *
 *   import { Program, AnchorProvider } from "@coral-xyz/anchor";
 *   import { IDL } from "../idl/lava_oracle";
 *
 *   function buildAnchorInstruction(payload: CommitPayload, payer: PublicKey) {
 *     const program = new Program(IDL, PROGRAM_ID, provider);
 *     return program.instruction.commitEntropy(
 *       payload.entropy_seed,
 *       payload.tokens_state_hash,
 *       { accounts: { payer, systemProgram: SystemProgram.programId } }
 *     );
 *   }
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { sendWithRetry, SendOptions } from "./solana";

// ─── SPL Memo Program ID (v2) ─────────────────────────────────────────────────

export const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
);

// ─── Payload type ─────────────────────────────────────────────────────────────

export interface CommitPayload {
  slot: number;
  blockhash: string;
  tokens_state_hash: string;
  docs_hash: string;       // SHA3-256 of sorted Supabase doc IDs (never the raw IDs)
  doc_count: number;       // how many IDs were hashed (informational)
  entropy_seed: string;
}

// ─── Memo content formatter ───────────────────────────────────────────────────

/**
 * Formats the entropy data into the canonical Memo string.
 * Format: LAVA_V1|slot=<slot>|blockhash=<bh>|tokens=<hash>|docs=<hash>|n=<count>|seed=<seed>
 *
 * Note: raw document IDs are NEVER written here — only their hash.
 */
export function formatMemoContent(payload: CommitPayload): string {
  return (
    `LAVA_V1` +
    `|slot=${payload.slot}` +
    `|blockhash=${payload.blockhash}` +
    `|tokens=${payload.tokens_state_hash}` +
    `|docs=${payload.docs_hash}` +
    `|n=${payload.doc_count}` +
    `|seed=${payload.entropy_seed}`
  );
}

/**
 * Parse a LAVA_V1 memo string back into its components.
 * Returns null if the string doesn't match the expected format.
 */
export function parseMemoContent(
  memo: string
): CommitPayload & { version: string } | null {
  const parts = memo.split("|");
  if (parts.length < 6 || parts[0] !== "LAVA_V1") return null;

  const get = (prefix: string): string | undefined =>
    parts.find((p) => p.startsWith(prefix + "="))?.slice(prefix.length + 1);

  const slotStr = get("slot");
  const blockhash = get("blockhash");
  const tokens_state_hash = get("tokens");
  const docs_hash = get("docs");
  const doc_count_str = get("n");
  const entropy_seed = get("seed");

  if (!slotStr || !blockhash || !tokens_state_hash || !docs_hash || !entropy_seed) return null;

  const slot = parseInt(slotStr, 10);
  if (isNaN(slot)) return null;

  const doc_count = doc_count_str ? parseInt(doc_count_str, 10) : 0;

  return {
    version: "LAVA_V1",
    slot,
    blockhash,
    tokens_state_hash,
    docs_hash,
    doc_count: isNaN(doc_count) ? 0 : doc_count,
    entropy_seed,
  };
}

// ─── Instruction builder ──────────────────────────────────────────────────────

/**
 * Build a Memo program instruction carrying the commit payload.
 *
 * EXTENSION POINT: Replace this function body with your Anchor instruction.
 */
export function buildMemoInstruction(
  memoText: string,
  signerPubkey: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [
      {
        pubkey: signerPubkey,
        isSigner: true,
        isWritable: false,
      },
    ],
    data: Buffer.from(memoText, "utf8"),
  });
}

// ─── Transaction builder ──────────────────────────────────────────────────────

/**
 * Build a transaction containing the commit instruction.
 * Uses the current latest blockhash for fee calculation and expiry.
 *
 * NOTE: We intentionally re-fetch a fresh blockhash here (not the snapshot
 * blockhash) to avoid the tx expiring before confirmation.
 */
export async function buildCommitTransaction(
  connection: Connection,
  payer: PublicKey,
  instruction: TransactionInstruction
): Promise<Transaction> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer;
  tx.lastValidBlockHeight = lastValidBlockHeight;

  tx.add(instruction);
  return tx;
}

// ─── High-level send ──────────────────────────────────────────────────────────

export interface CommitResult {
  signature: string;
  explorerUrl: string;
}

/**
 * Build, sign, and send the commit transaction. Returns the signature.
 */
export async function sendCommit(
  connection: Connection,
  payer: Keypair,
  payload: CommitPayload,
  retryOptions?: SendOptions
): Promise<CommitResult> {
  const memoText = formatMemoContent(payload);
  const instruction = buildMemoInstruction(memoText, payer.publicKey);
  const tx = await buildCommitTransaction(connection, payer.publicKey, instruction);

  const signature = await sendWithRetry(connection, tx, [payer], retryOptions);

  const explorerUrl = `https://explorer.solana.com/tx/${signature}?cluster=devnet`;

  return { signature, explorerUrl };
}
