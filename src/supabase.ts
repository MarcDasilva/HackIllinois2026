/**
 * src/supabase.ts
 *
 * Supabase client + document ID fetcher.
 *
 * Responsibilities:
 *   - Create an authenticated Supabase client from env vars.
 *   - Fetch the primary key (UUID) column from a configurable table.
 *   - Return a stable, sorted list of ID strings ready for hashing.
 *
 * Environment variables:
 *   SUPABASE_URL        — e.g. https://xyzxyz.supabase.co
 *   SUPABASE_SERVICE_KEY — Service role key (never the anon key for backend use)
 *   SUPABASE_TABLE      — Table name to read IDs from (default: "documents")
 *   SUPABASE_ID_COLUMN  — Primary key column name (default: "id")
 *   SUPABASE_LIMIT      — Max rows to fetch per tick (default: 1000)
 *
 * Security model:
 *   - Uses the SERVICE ROLE key so RLS does not block reads.
 *   - The key is read-only from env — never logged or written anywhere.
 *   - Raw IDs never leave this process; only their SHA3-256 hash is
 *     passed downstream and committed on-chain.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DocumentIdResult {
  /** Sorted list of UUID strings fetched from Supabase. */
  ids: string[];
  /** Name of the table that was queried. */
  table: string;
  /** Number of rows returned. */
  count: number;
}

export interface TokenAccountResult {
  /** Sorted list of token account pubkeys fetched from Supabase. */
  pubkeys: string[];
  /** Name of the table that was queried. */
  table: string;
  /** Number of rows returned. */
  count: number;
}

// ─── Config ───────────────────────────────────────────────────────────────────

function getConfig(): {
  url: string;
  serviceKey: string;
  table: string;
  idColumn: string;
  limit: number;
} {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!url || url.trim() === "") {
    throw new Error(
      "SUPABASE_URL is not set. Add it to your .env file.\n" +
        "  Example: SUPABASE_URL=https://yourproject.supabase.co"
    );
  }

  if (!serviceKey || serviceKey.trim() === "") {
    throw new Error(
      "SUPABASE_SERVICE_KEY is not set. Add your service role key to .env.\n" +
        "  Find it at: Supabase Dashboard → Project Settings → API → service_role key\n" +
        "  IMPORTANT: Never use the anon key for backend service access."
    );
  }

  const table = process.env.SUPABASE_TABLE?.trim() || "documents";
  const idColumn = process.env.SUPABASE_ID_COLUMN?.trim() || "id";
  const limit = parsePositiveInt(process.env.SUPABASE_LIMIT, 1000);

  return { url, serviceKey, table, idColumn, limit };
}

function getTokenAccountConfig(): {
  table: string;
  keyColumn: string;
  limit: number;
} {
  const table = process.env.SUPABASE_TOKEN_TABLE?.trim() || "token_accounts";
  const keyColumn = process.env.SUPABASE_TOKEN_COLUMN?.trim() || "pubkey";
  const limit = parsePositiveInt(process.env.SUPABASE_TOKEN_LIMIT, 100);
  return { table, keyColumn, limit };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? "", 10);
  if (isNaN(parsed) || parsed < 1) return fallback;
  return parsed;
}

// ─── Client factory (singleton) ───────────────────────────────────────────────

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client;

  const { url, serviceKey } = getConfig();

  _client = createClient(url, serviceKey, {
    auth: {
      // Service role key — disable auto session management
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return _client;
}

// ─── Document ID fetcher ──────────────────────────────────────────────────────

/**
 * Fetches all row IDs from the configured Supabase table.
 *
 * The returned IDs are sorted lexicographically so the downstream hash
 * is deterministic regardless of Postgres query order.
 *
 * Throws if the query fails or the ID column is missing/null.
 */
export async function fetchDocumentIds(): Promise<DocumentIdResult> {
  const { table, idColumn, limit } = getConfig();
  const client = getSupabaseClient();

  const { data, error } = await client
    .from(table)
    .select(idColumn)
    .limit(limit)
    .order(idColumn, { ascending: true });

  if (error) {
    throw new Error(
      `Supabase query failed on table "${table}": ${error.message} (code: ${error.code})\n` +
        `  Check that the table exists and SUPABASE_SERVICE_KEY has read access.`
    );
  }

  if (!Array.isArray(data)) {
    throw new Error(
      `Supabase returned unexpected data format for table "${table}". Expected an array.`
    );
  }

  const ids: string[] = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i] as unknown as Record<string, unknown>;
    const val = row[idColumn];

    if (val === null || val === undefined) {
      // Skip null PKs (shouldn't happen with a proper PK column, but be safe)
      console.warn(`[supabase] Row ${i} has null/undefined "${idColumn}" — skipping.`);
      continue;
    }

    ids.push(String(val));
  }

  // Sort lexicographically for deterministic hashing
  ids.sort();

  return { ids, table, count: ids.length };
}

/**
 * Fetches token account pubkeys from a dedicated Supabase table.
 *
 * The returned pubkeys are sorted lexicographically so downstream
 * snapshot ordering is deterministic.
 */
export async function fetchTokenAccountPubkeys(): Promise<TokenAccountResult> {
  const { table, keyColumn, limit } = getTokenAccountConfig();
  const client = getSupabaseClient();

  const { data, error } = await client
    .from(table)
    .select(keyColumn)
    .limit(limit)
    .order(keyColumn, { ascending: true });

  if (error) {
    throw new Error(
      `Supabase token account query failed on table "${table}": ${error.message} (code: ${error.code})\n` +
        `  Check SUPABASE_TOKEN_TABLE/SUPABASE_TOKEN_COLUMN and confirm the table exists.`
    );
  }

  if (!Array.isArray(data)) {
    throw new Error(
      `Supabase returned unexpected data format for token accounts table "${table}". Expected an array.`
    );
  }

  const pubkeys: string[] = [];

  for (let i = 0; i < data.length; i++) {
    const row = data[i] as unknown as Record<string, unknown>;
    const val = row[keyColumn];

    if (val === null || val === undefined) {
      console.warn(`[supabase] Token row ${i} has null/undefined "${keyColumn}" - skipping.`);
      continue;
    }

    const key = String(val).trim();
    if (key.length === 0) continue;
    pubkeys.push(key);
  }

  pubkeys.sort();

  return { pubkeys, table, count: pubkeys.length };
}

// ─── Validation helper ────────────────────────────────────────────────────────

/**
 * Validate Supabase connection at startup (call once from index.ts).
 * Fetches a single row to confirm credentials and table access are correct.
 */
export async function validateSupabaseConnection(): Promise<void> {
  const { table, idColumn } = getConfig();
  const client = getSupabaseClient();

  const { error } = await client
    .from(table)
    .select(idColumn)
    .limit(1);

  if (error) {
    throw new Error(
      `Supabase connection validation failed:\n` +
        `  Table    : ${table}\n` +
        `  Column   : ${idColumn}\n` +
        `  Error    : ${error.message} (code: ${error.code})\n\n` +
        `  Checklist:\n` +
        `    1. Is SUPABASE_URL correct?\n` +
        `    2. Is SUPABASE_SERVICE_KEY the service role key (not anon)?\n` +
        `    3. Does the table "${table}" exist?\n` +
        `    4. Does the column "${idColumn}" exist in that table?`
    );
  }

  console.log(`[supabase] Connection validated — table="${table}", column="${idColumn}"`);
}
