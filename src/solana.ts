/**
 * src/solana.ts
 *
 * Manages the Solana Connection, payer Keypair, and transaction sending
 * with exponential-backoff retry for transient RPC errors.
 *
 * EXTENSION POINT: to swap Memo for a custom Anchor program, replace the
 * call-site in memoCommit.ts — this module stays the same.
 */

import {
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
  PublicKey,
  Commitment,
} from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ─── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_KEYPAIR_PATH = path.join(os.homedir(), ".config", "solana", "id.json");
const COMMITMENT: Commitment = "confirmed";

// ─── Connection ───────────────────────────────────────────────────────────────

export function createConnection(): Connection {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? DEFAULT_RPC_URL;
  return new Connection(rpcUrl, COMMITMENT);
}

// ─── Keypair ──────────────────────────────────────────────────────────────────

export function loadKeypair(): Keypair {
  const rawPath = process.env.SOLANA_KEYPAIR_PATH ?? DEFAULT_KEYPAIR_PATH;
  // Expand leading ~ to the home directory
  const keypairPath = rawPath.startsWith("~")
    ? path.join(os.homedir(), rawPath.slice(1))
    : rawPath;

  if (!fs.existsSync(keypairPath)) {
    throw new Error(
      `Keypair file not found at "${keypairPath}". ` +
        `Set SOLANA_KEYPAIR_PATH or run: solana-keygen new --outfile ${keypairPath}`
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse keypair file "${keypairPath}": ${String(err)}`);
  }

  if (!Array.isArray(raw)) {
    throw new Error(`Keypair file "${keypairPath}" must be a JSON array of bytes.`);
  }

  return Keypair.fromSecretKey(Uint8Array.from(raw as number[]));
}

// ─── Balance helper ───────────────────────────────────────────────────────────

export async function getBalanceSol(
  connection: Connection,
  pubkey: PublicKey
): Promise<number> {
  const lamports = await connection.getBalance(pubkey, COMMITMENT);
  return lamports / 1e9;
}

// ─── Retry Send ───────────────────────────────────────────────────────────────

export interface SendOptions {
  maxRetries?: number;   // default 5
  baseDelayMs?: number;  // default 800
}

/**
 * Sends and confirms a transaction with exponential-backoff retry.
 * Throws after maxRetries exhausted.
 */
export async function sendWithRetry(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[],
  options: SendOptions = {}
): Promise<string> {
  const maxRetries = options.maxRetries ?? 5;
  const baseDelay = options.baseDelayMs ?? 800;

  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const sig = await sendAndConfirmTransaction(connection, transaction, signers, {
        commitment: COMMITMENT,
      });
      return sig;
    } catch (err: unknown) {
      lastErr = err;
      const isTransient = isTransientError(err);

      if (!isTransient || attempt === maxRetries) {
        throw new Error(
          `Transaction failed after ${attempt + 1} attempt(s): ${String(err)}`
        );
      }

      const delay = baseDelay * Math.pow(2, attempt);
      console.warn(
        `[solana] Transient error on attempt ${attempt + 1}/${maxRetries + 1}. ` +
          `Retrying in ${delay}ms… (${String(err)})`
      );
      await sleep(delay);
    }
  }

  // Should never reach here, but satisfies TypeScript
  throw lastErr;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isTransientError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("blockhash not found") ||
    msg.includes("timeout") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("429") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("network") ||
    msg.includes("too many requests")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
