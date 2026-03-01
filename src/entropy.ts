/**
 * src/entropy.ts
 *
 * Deterministic entropy derivation from a chain snapshot + Supabase document IDs.
 *
 * Algorithm:
 *   1. Sort token accounts by pubkey (lexicographic).
 *   2. Stable-stringify the sorted array → tokens_state_hash = sha3_256(json).
 *   3. Sort document IDs lexicographically → docs_hash = sha3_256(ids joined by "|").
 *   4. entropy_seed = sha3_256(tokens_state_hash | docs_hash | slot | blockhash)
 *
 * docs_hash is computed over the raw IDs — they never leave this process.
 * Only the hash is passed downstream and committed on-chain.
 *
 * "Stable stringify" ensures identical input always produces identical JSON
 * regardless of JS engine key insertion order.
 */

import * as crypto from "crypto";
import { ChainSnapshot, TokenState } from "./snapshot";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EntropyResult {
  tokens_state_hash: string;
  docs_hash: string;
  entropy_seed: string;
  canonical_tokens_json: string;
  doc_count: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Given a ChainSnapshot and a sorted list of document IDs from Supabase,
 * compute deterministic entropy that commits to both sources.
 *
 * @param snapshot   - Chain state (slot, blockhash, token accounts)
 * @param documentIds - Sorted UUID strings fetched from Supabase (pass [] to omit)
 */
export function computeEntropy(
  snapshot: ChainSnapshot,
  documentIds: string[] = []
): EntropyResult {
  // 1. Sort token states by pubkey
  const sorted = [...snapshot.token_states].sort((a, b) =>
    a.token_account_pubkey.localeCompare(b.token_account_pubkey)
  );

  // 2. Stable-stringify each state and the full array
  const canonical_tokens_json = stableStringify(sorted);

  // 3. Hash the canonical token state JSON
  const tokens_state_hash = sha3_256(canonical_tokens_json);

  // 4. Hash the document IDs (already sorted by supabase.ts)
  //    Join with "|" as a delimiter — safe since UUIDs never contain "|"
  const docs_canonical = documentIds.sort().join("|");
  const docs_hash = sha3_256(docs_canonical);

  // 5. Combine everything and derive final seed
  const combined = `${tokens_state_hash}|${docs_hash}|${snapshot.slot}|${snapshot.blockhash}`;
  const entropy_seed = sha3_256(combined);

  return {
    tokens_state_hash,
    docs_hash,
    entropy_seed,
    canonical_tokens_json,
    doc_count: documentIds.length,
  };
}

// ─── SHA3-256 ─────────────────────────────────────────────────────────────────

/**
 * Compute SHA3-256 (Keccak-256 is different; this is NIST SHA3-256).
 * Node >= 18 ships OpenSSL with sha3-256 support.
 */
export function sha3_256(input: string): string {
  return crypto.createHash("sha3-256").update(input, "utf8").digest("hex");
}

// ─── Stable Stringify ─────────────────────────────────────────────────────────

/**
 * Deterministic JSON serializer.
 * - Object keys are sorted lexicographically at every nesting level.
 * - Arrays preserve their order (already sorted by caller for token states).
 * - Primitives are serialized by JSON.stringify.
 *
 * This guarantees the same output regardless of property insertion order
 * in the JS runtime.
 */
export function stableStringify(value: unknown): string {
  return innerStringify(value);
}

function innerStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";

  if (typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => innerStringify(item));
    return `[${items.join(",")}]`;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys.map((k) => `${JSON.stringify(k)}:${innerStringify(obj[k])}`);
    return `{${pairs.join(",")}}`;
  }

  // Fallback (BigInt, Symbol, functions — shouldn't appear in our data)
  return JSON.stringify(String(value));
}

// ─── Type guard helper ────────────────────────────────────────────────────────

export function isTokenStateFallback(
  state: TokenState
): state is import("./snapshot").TokenAccountStateFallback {
  return "raw_data_hash" in state;
}
