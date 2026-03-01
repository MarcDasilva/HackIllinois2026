/**
 * src/snapshot.ts
 *
 * Fetches and canonicalizes state for a list of token accounts plus
 * chain-level values (slot, blockhash).
 *
 * The "canonical state" object is a stable, deterministic representation
 * used as input to the entropy hash — see entropy.ts.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import * as crypto from "crypto";
import { fetchTokenAccountPubkeys } from "./supabase";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Canonical state for a single token account (parsed path). */
export interface TokenAccountState {
  token_account_pubkey: string;
  owner: string;
  mint: string;
  amount: string;
  decimals: number | null;
  program: string;
}

/** Fallback state when parsed info is unavailable. */
export interface TokenAccountStateFallback {
  token_account_pubkey: string;
  raw_data_hash: string; // sha3-256 of raw base64 bytes
  error: string;
}

export type TokenState = TokenAccountState | TokenAccountStateFallback;

export interface ChainSnapshot {
  slot: number;
  blockhash: string;
  token_states: TokenState[];
}

// ─── Token Account Loader ─────────────────────────────────────────────────────

/**
 * Load token account pubkeys.
 * Priority: TOKEN_ACCOUNTS env var -> Supabase token_accounts table -> config/token_accounts.json
 */
export async function loadTokenAccounts(): Promise<PublicKey[]> {
  const envList = process.env.TOKEN_ACCOUNTS;
  let rawKeys: string[];

  if (envList && envList.trim().length > 0) {
    rawKeys = envList.split(",").map((k) => k.trim()).filter(Boolean);
  } else {
    try {
      const tokenResult = await fetchTokenAccountPubkeys();
      rawKeys = tokenResult.pubkeys;
      if (rawKeys.length === 0) {
        throw new Error(
          `Supabase token table "${tokenResult.table}" returned 0 rows. ` +
            `Seed it first or set TOKEN_ACCOUNTS in .env.`
        );
      }
    } catch (supabaseErr) {
      // Final fallback: local config file for backwards compatibility.
      const configPath = process.cwd() + "/config/token_accounts.json";
      let parsed: unknown;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        parsed = require(configPath) as unknown;
      } catch {
        throw new Error(
          `No TOKEN_ACCOUNTS env var, Supabase token seed failed, and config file not found at "${configPath}". ` +
            `Supabase error: ${String(supabaseErr)}`
        );
      }

      if (!Array.isArray(parsed)) {
        throw new Error(
          `"config/token_accounts.json" must be a JSON array of public key strings.`
        );
      }
      rawKeys = (parsed as unknown[]).map((v) => {
        if (typeof v !== "string") {
          throw new Error(`Each entry in token_accounts.json must be a string; got ${typeof v}`);
        }
        return v.trim();
      });
    }
  }

  if (rawKeys.length === 0) {
    throw new Error(
      `Expected at least 1 token account pubkey, got ${rawKeys.length}. ` +
        `Check TOKEN_ACCOUNTS, Supabase token seed, or config/token_accounts.json.`
    );
  }

  return rawKeys.map((key, i) => {
    try {
      return new PublicKey(key);
    } catch {
      throw new Error(`Invalid public key at index ${i}: "${key}"`);
    }
  });
}

// ─── Snapshot Fetcher ─────────────────────────────────────────────────────────

/**
 * Fetches slot, latest blockhash, and parsed info for all token accounts.
 * Token accounts are returned in the same order as `pubkeys`.
 */
export async function fetchSnapshot(
  connection: Connection,
  pubkeys: PublicKey[]
): Promise<ChainSnapshot> {
  // Fetch chain-level values in parallel with the first batch of account calls
  const [slot, { blockhash }, ...accountResults] = await Promise.all([
    connection.getSlot("confirmed"),
    connection.getLatestBlockhash("confirmed"),
    ...pubkeys.map((pk) => fetchTokenState(connection, pk)),
  ]);

  return {
    slot,
    blockhash,
    token_states: accountResults,
  };
}

// ─── Per-account fetch ────────────────────────────────────────────────────────

async function fetchTokenState(
  connection: Connection,
  pubkey: PublicKey
): Promise<TokenState> {
  const pubkeyStr = pubkey.toBase58();

  try {
    const result = await connection.getParsedAccountInfo(pubkey, "confirmed");

    if (result.value === null) {
      return fallback(pubkeyStr, new Uint8Array(0), "Account not found on-chain");
    }

    const accountData = result.value.data;

    // Check if we have parsed data (Buffer indicates unparsed binary)
    if (Buffer.isBuffer(accountData)) {
      // Raw bytes — fall back to hash
      return fallback(pubkeyStr, accountData, "Account data is not parsed (not an SPL token account)");
    }

    // accountData is ParsedAccountData
    const parsed = accountData.parsed as Record<string, unknown> | undefined;
    if (!parsed || typeof parsed !== "object") {
      return fallback(pubkeyStr, new Uint8Array(0), "No parsed field in account data");
    }

    const info = parsed["info"] as Record<string, unknown> | undefined;
    if (!info || typeof info !== "object") {
      return fallback(pubkeyStr, new Uint8Array(0), "No info field in parsed account data");
    }

    const tokenAmount = info["tokenAmount"] as Record<string, unknown> | undefined;

    const state: TokenAccountState = {
      token_account_pubkey: pubkeyStr,
      owner: stringField(info, "owner"),
      mint: stringField(info, "mint"),
      amount: tokenAmount
        ? stringField(tokenAmount, "amount")
        : stringField(info, "amount"),
      decimals: tokenAmount
        ? numberFieldOrNull(tokenAmount, "decimals")
        : null,
      program: accountData.program ?? "spl-token",
    };

    return state;
  } catch (err: unknown) {
    return fallback(pubkeyStr, new Uint8Array(0), `RPC error: ${String(err)}`);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fallback(
  pubkeyStr: string,
  rawBytes: Uint8Array | Buffer,
  reason: string
): TokenAccountStateFallback {
  const hash = crypto
    .createHash("sha3-256")
    .update(Buffer.from(rawBytes))
    .digest("hex");

  return {
    token_account_pubkey: pubkeyStr,
    raw_data_hash: hash,
    error: reason,
  };
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const val = obj[key];
  if (typeof val === "string") return val;
  if (val === undefined || val === null) return "";
  return String(val);
}

function numberFieldOrNull(obj: Record<string, unknown>, key: string): number | null {
  const val = obj[key];
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = Number(val);
    return isNaN(n) ? null : n;
  }
  return null;
}
