# LAVA Entropy Oracle

A minimal, production-lean Node.js + TypeScript backend that:

1. Fetches Solana devnet state (slot + latest blockhash) and ~100 token account states every N seconds.
2. Fetches row UUIDs from a **Supabase** table (your document IDs).
3. Computes a deterministic **SHA3-256 entropy seed** from all three sources — token state + doc IDs + chain values.
4. Commits only the **hash** of the doc IDs on-chain via the **SPL Memo program** (raw IDs never leave your backend).
5. Persists every commit to `data/commits.jsonl`.
6. Ships a verifier CLI to inspect any committed transaction.

---

## Project Structure

```
.
├── src/
│   ├── index.ts          # Main loop (orchestration)
│   ├── solana.ts         # Connection, keypair loader, tx send w/ retry
│   ├── snapshot.ts       # Fetch & canonicalize token account states
│   ├── entropy.ts        # Stable stringify + SHA3-256 derivation
│   ├── memoCommit.ts     # Build Memo instruction + send commit tx
│   ├── supabase.ts       # Supabase client + document ID fetcher
│   ├── verifyMemo.ts     # CLI: fetch tx and verify LAVA_V1 memo
│   └── bs58shim.ts       # Internal: bs58 re-export for verifier fallback
├── scripts/
│   └── bootstrap.ts      # One-time: create ~100 devnet token accounts + seed Supabase
├── config/
│   ├── token_accounts.example.json   # Optional local fallback only
│   └── token_accounts.json           # Optional local fallback (git-ignored)
├── data/                             # Persisted commits (git-ignored)
│   └── commits.jsonl
├── .env.example
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 18 |
| npm | ≥ 9 |
| Solana CLI | ≥ 1.18 (for keygen + airdrop) |

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` — Supabase vars are required, Solana vars have devnet defaults:

```
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_KEYPAIR_PATH=~/.config/solana/id.json
ENTROPY_INTERVAL_MS=5000
TOKEN_ACCOUNTS=          # optional override; leave blank to use Supabase token_accounts table
DRY_RUN=false

SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_TABLE=documents
SUPABASE_ID_COLUMN=id
SUPABASE_LIMIT=1000
SUPABASE_TOKEN_TABLE=token_accounts
SUPABASE_TOKEN_COLUMN=pubkey
SUPABASE_TOKEN_LIMIT=100
```

### 3. Configure Supabase

1. Go to your [Supabase Dashboard](https://app.supabase.com) → **Project Settings** → **API**
2. Copy **Project URL** → `SUPABASE_URL`
3. Copy **service_role** key (the secret one, not anon) → `SUPABASE_SERVICE_KEY`
4. Set `SUPABASE_TABLE` to the table whose row IDs you want committed
5. Set `SUPABASE_ID_COLUMN` to the primary key column name (usually `id`)

> **Why service role?** The service role key bypasses Row Level Security so the oracle can always read IDs regardless of RLS policies. It is only used server-side and never exposed to clients.

> **Privacy guarantee:** Only a SHA3-256 hash of the sorted IDs is committed on-chain. The raw UUIDs never leave your server and are never logged.

### 4. Create (or fund) your payer keypair

```bash
# Generate a new keypair (skip if you already have one)
solana-keygen new --outfile ~/.config/solana/id.json

# Fund with devnet SOL (you need ~0.01 SOL per commit)
solana airdrop 2 --url https://api.devnet.solana.com
```

### 5. Seed token accounts in Supabase (~100)

First, run this migration in Supabase SQL Editor:

```
supabase/migrations/20260228123000_add_token_accounts.sql
```

Run the bootstrap script to create fresh devnet token accounts and upsert them into Supabase:

```bash
npm run bootstrap:tokens
```

Optional: override via `.env` (comma-separated list):

```bash
# In .env:
TOKEN_ACCOUNTS=Pubkey1,Pubkey2,...
```

Legacy fallback (local file) is still supported:

```bash
cp config/token_accounts.example.json config/token_accounts.json
# Edit with real devnet token account pubkeys
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Solana RPC endpoint |
| `SOLANA_KEYPAIR_PATH` | `~/.config/solana/id.json` | Path to payer keypair JSON |
| `ENTROPY_INTERVAL_MS` | `5000` | Milliseconds between oracle ticks |
| `TOKEN_ACCOUNTS` | _(empty)_ | Optional comma-separated token account pubkeys override |
| `DRY_RUN` | `false` | If `true`, compute entropy but do not submit a transaction |
| `SUPABASE_URL` | _(required)_ | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | _(required)_ | Supabase service role secret key |
| `SUPABASE_TABLE` | `documents` | Table to read row IDs from |
| `SUPABASE_ID_COLUMN` | `id` | Primary key column name |
| `SUPABASE_LIMIT` | `1000` | Max rows fetched per tick |
| `SUPABASE_TOKEN_TABLE` | `token_accounts` | Table to read token account pubkeys from |
| `SUPABASE_TOKEN_COLUMN` | `pubkey` | Column name containing token account pubkeys |
| `SUPABASE_TOKEN_LIMIT` | `100` | Max token accounts fetched per tick |

---

## Running

### Development (ts-node, no build step)

```bash
npm run dev
```

### Production (compile then run)

```bash
npm run build
npm start
```

### Dry-run (compute entropy, no tx submitted)

```bash
DRY_RUN=true npm run dev
```

### Expected startup output

```
═══════════════════════════════════════════════════════════════
  LAVA Entropy Oracle — Solana Devnet + Supabase
═══════════════════════════════════════════════════════════════
  RPC URL    : https://api.devnet.solana.com
  Payer      : <your-pubkey>
  Balance    : 1.9980 SOL
  Interval   : 5000ms
  Dry-run    : false
  Supabase   : https://yourproject.supabase.co
  Table      : documents
  Commits    : /path/to/data/commits.jsonl
═══════════════════════════════════════════════════════════════
[supabase] Connection validated — table="documents", column="id"
[index] Loaded 100 token accounts.
[index] Starting oracle loop. Press Ctrl+C to stop.

[tick] Fetching Supabase IDs + Solana snapshot in parallel…
[tick] Snapshot  — slot=350123456  blockhash=AbCdEf…
[tick] Supabase  — table="documents"  ids=142
[tick] ts                : 2026-02-28T12:00:00.000Z
[tick] slot              : 350123456
[tick] doc_count         : 142
[tick] tokens_state_hash : a3f9...b82c
[tick] docs_hash         : 9c2e...f341
[tick] entropy_seed      : 7d1e...4f90
[tick] Submitting commit transaction…
[tick] Confirmed! Signature: 5xKjP…
[tick] Explorer  : https://explorer.solana.com/tx/5xKjP…?cluster=devnet
[tick] Persisted to data/commits.jsonl  (1842ms total)
```

---

## Verifier CLI

After the oracle commits a transaction, you can verify it:

```bash
npm run verify -- <transaction-signature>
```

Example:

```bash
npm run verify -- 5xKjPmWqNvRtYfHgBdCzA2…
```

Output:
```
── Transaction Info ───────────────────────────────────────────
  Signature : 5xKjP…
  Slot      : 350123456
  Block time: 2026-02-28T12:00:01.500Z
  Status    : SUCCESS
  Explorer  : https://explorer.solana.com/tx/5xKjP…?cluster=devnet

── Raw Memo Content ───────────────────────────────────────────
  LAVA_V1|slot=350123456|blockhash=AbCdEf…|tokens=a3f9…|docs=9c2e…|n=142|seed=7d1e…

── Parsed LAVA_V1 Fields ──────────────────────────────────────
  version           : LAVA_V1
  slot              : 350123456
  blockhash         : AbCdEf…
  tokens_state_hash : a3f9…b82c
  docs_hash         : 9c2e…f341
  doc_count         : 142
  entropy_seed      : 7d1e…4f90

── Validation ─────────────────────────────────────────────────
  All checks passed.

[verifyMemo] Verification complete.
```

---

## Persisted Data

Each oracle tick appends one JSON line to `data/commits.jsonl`:

```jsonl
{"ts":"2026-02-28T12:00:00.000Z","slot":350123456,"blockhash":"AbCdEf…","tokens_state_hash":"a3f9…","docs_hash":"9c2e…","doc_count":142,"entropy_seed":"7d1e…","signature":"5xKjP…"}
```

`signature` is `null` in dry-run mode or when the transaction fails.

---

## Entropy Algorithm

```
# Token state commitment
canonical_tokens_json = stableStringify(sort(token_states, by=pubkey))
tokens_state_hash     = sha3_256(canonical_tokens_json)

# Document ID commitment  (raw IDs never leave the server)
docs_canonical        = sort(supabase_uuids).join("|")
docs_hash             = sha3_256(docs_canonical)

# Final seed: all three sources combined
entropy_seed          = sha3_256(tokens_state_hash + "|" + docs_hash + "|" + slot + "|" + blockhash)
```

**Stable stringify** sorts object keys lexicographically at every nesting level, ensuring identical output regardless of JS engine insertion order.

**Privacy:** Raw document IDs are hashed locally before anything leaves the process. The Memo on-chain contains only `docs_hash` — a one-way commitment. To later prove a specific set of IDs was committed, re-hash the sorted ID list and compare against the on-chain `docs_hash`.

**Token state fallback:** If `getParsedAccountInfo` returns raw bytes (account is not an SPL token account), the oracle hashes the raw base64 data and records `{ token_account_pubkey, raw_data_hash, error }` instead of crashing.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `Keypair file not found` | Run `solana-keygen new` or set `SOLANA_KEYPAIR_PATH` |
| `Expected at least 1 token account pubkey, got 0` | Seed Supabase token_accounts table (or set `TOKEN_ACCOUNTS`) |
| `Transaction failed: blockhash not found` | RPC is slow; the oracle retries automatically (5 attempts, exponential backoff) |
| `Balance is low` | Run `solana airdrop 2 --url devnet` |
| `sha3-256` not supported | Ensure Node.js ≥ 18 (ships OpenSSL 3 with SHA3 support) |
| `503 / 429 from RPC` | Switch to a private RPC (e.g. Helius, QuickNode) via `SOLANA_RPC_URL` |
| Transaction not found in verifier | Wait ~5s for confirmation, then retry |
| `SUPABASE_URL is not set` | Add `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` to your `.env` file |
| `Supabase query failed` | Check table name (`SUPABASE_TABLE`), column name (`SUPABASE_ID_COLUMN`), and that your service role key has read access |
| `Supabase fetch failed (using empty list)` | Supabase error mid-run; oracle continues with empty doc list and logs a warning. Check your Supabase project status. |

---

## Next Step: Swap Memo for a Custom Solana Program

When you're ready to replace the Memo program with your own Anchor instruction, **only one file needs to change: `src/memoCommit.ts`**.

Here's exactly what to do:

### 1. Install Anchor

```bash
npm install @coral-xyz/anchor
```

### 2. Add your IDL

Place your compiled IDL at `src/idl/lava_oracle.json`.

### 3. Replace `buildMemoInstruction` in `src/memoCommit.ts`

```typescript
// Before (Memo):
import { MEMO_PROGRAM_ID } from "./memoCommit";

function buildMemoInstruction(memoText: string, signerPubkey: PublicKey) {
  return new TransactionInstruction({ programId: MEMO_PROGRAM_ID, ... });
}

// After (Anchor):
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { IDL } from "./idl/lava_oracle";

const PROGRAM_ID = new PublicKey("YOUR_PROGRAM_ID_HERE");

function buildAnchorInstruction(
  payload: CommitPayload,
  payer: Keypair,
  connection: Connection
): TransactionInstruction {
  const provider = new AnchorProvider(
    connection,
    new Wallet(payer),
    { commitment: "confirmed" }
  );
  const program = new Program(IDL, PROGRAM_ID, provider);

  // Replace with your actual instruction name and account structure:
  return program.instruction.commitEntropy(
    Buffer.from(payload.entropy_seed, "hex"),
    Buffer.from(payload.tokens_state_hash, "hex"),
    {
      accounts: {
        payer: payer.publicKey,
        entropyState: deriveEntropyPDA(payload.slot),
        systemProgram: SystemProgram.programId,
      },
    }
  );
}
```

### 4. Update `sendCommit` to call `buildAnchorInstruction`

```typescript
// In sendCommit(), replace:
const instruction = buildMemoInstruction(memoText, payer.publicKey);
// With:
const instruction = buildAnchorInstruction(payload, payer, connection);
```

`src/index.ts`, `src/solana.ts`, `src/entropy.ts`, `src/snapshot.ts`, and the persistence layer all remain **unchanged**.

---

## Google Drive Integration

The server exposes an HTTP API for transferring files between Drive folders,
with state tracked in Supabase so the entropy oracle automatically picks up
every document change.

### Architecture

```
User → GET /oauth/google           → Google consent page
Google → GET /oauth/callback       → tokens stored in user_integrations table
Client → POST /transfer            → moves file in Drive, updates documents row
Oracle (index.ts) next tick        → sees updated row, includes new state in hash
```

### Setup

#### 1. Create a Google Cloud project & OAuth credentials

1. Go to [https://console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
2. Create an **OAuth 2.0 Client ID** (Application type: **Web application**)
3. Add `http://localhost:3000/oauth/callback` to **Authorized redirect URIs**
4. Enable the **Google Drive API** under *APIs & Services → Enabled APIs*
5. Copy your **Client ID** and **Client Secret**

#### 2. Run the Supabase migration

In **Supabase Dashboard → SQL Editor**, run:

```
supabase/migrations/20260228010000_add_drive_integration.sql
```

This adds:
- `user_integrations` table — stores OAuth tokens per user
- Drive-specific columns on `documents` (`drive_file_id`, `drive_folder_id`, `mime_type`, `transfer_status`, …)

#### 3. Add Google env vars to `.env`

```
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth/callback
OAUTH_SUCCESS_REDIRECT=       # optional — redirect after OAuth
SERVER_PORT=3000
```

#### 4. Start the server

```bash
npm run dev:server
```

### API reference

#### Connect Google Drive

```
GET /oauth/google?user_id=<supabase-uuid>
```

Redirects the user to Google's consent page. After approval, Google calls
`/oauth/callback` and tokens are stored automatically.

#### Trigger a file transfer

```
POST /transfer
Content-Type: application/json

{
  "document_id":      "uuid-of-documents-row",
  "target_folder_id": "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
  "user_id":          "supabase-user-uuid"
}
```

**Response (200 — success):**

```json
{
  "documentId":    "uuid-of-documents-row",
  "status":        "done",
  "newFolderId":   "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms",
  "transferredAt": "2026-02-28T22:00:00.000Z"
}
```

**Response (500 — error):**

```json
{
  "documentId": "uuid-of-documents-row",
  "status":     "error",
  "error":      "Reason the transfer failed"
}
```

#### Health check

```
GET /health
```

### transfer_status lifecycle

| Status | Meaning |
|---|---|
| `none` | No transfer requested |
| `pending` | POST /transfer received, job not yet started |
| `in_progress` | Drive API call in flight |
| `done` | Transfer succeeded |
| `error` | Last attempt failed — see `transfer_error` column |

### How the oracle picks up changes

The entropy oracle (`src/index.ts`) needs **zero changes**. On each tick it fetches
all row IDs from `documents` — after a transfer updates `drive_folder_id` or
`transferred_at`, the `updated_at` timestamp changes, and the oracle's next hash
reflects the new state automatically.

---

## License

MIT
