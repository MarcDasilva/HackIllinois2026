/**
 * scripts/bootstrap.ts
 *
 * One-time setup script: creates ~100 SPL token accounts on devnet
 * (using a single shared mint for simplicity) and upserts their
 * public keys into a Supabase table (default: public.token_accounts).
 *
 * Run once:
 *   npx ts-node scripts/bootstrap.ts
 */

import "dotenv/config";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  createInitializeMintInstruction,
  getMinimumBalanceForRentExemptMint,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
} from "@solana/spl-token";
import { createClient } from "@supabase/supabase-js";

import { createConnection, loadKeypair } from "../src/solana";

const NUM_ACCOUNTS = parsePositiveInt(process.env.TOKEN_BOOTSTRAP_COUNT, 100);
const TOKEN_TABLE = process.env.SUPABASE_TOKEN_TABLE?.trim() || "token_accounts";
const TOKEN_COLUMN = process.env.SUPABASE_TOKEN_COLUMN?.trim() || "pubkey";

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? "", 10);
  if (isNaN(parsed) || parsed < 1) return fallback;
  return parsed;
}

function createSupabaseServiceClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!url || url.trim() === "") {
    throw new Error("SUPABASE_URL is required to seed token accounts.");
  }

  if (!serviceKey || serviceKey.trim() === "") {
    throw new Error("SUPABASE_SERVICE_KEY is required to seed token accounts.");
  }

  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

async function main() {
  const connection = createConnection();
  const payer = loadKeypair();

  console.log(`[bootstrap] Payer: ${payer.publicKey.toBase58()}`);
  const balance = await connection.getBalance(payer.publicKey);
  console.log(`[bootstrap] Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  // ── Create a mint ──────────────────────────────────────────────────────────
  console.log(`\n[bootstrap] Creating mint…`);
  const mint = Keypair.generate();
  const mintLamports = await getMinimumBalanceForRentExemptMint(connection);

  const createMintTx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint.publicKey,
      space: MINT_SIZE,
      lamports: mintLamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      mint.publicKey,
      6, // decimals
      payer.publicKey,
      payer.publicKey
    )
  );

  await sendAndConfirmTransaction(connection, createMintTx, [payer, mint], {
    commitment: "confirmed",
  });
  console.log(`[bootstrap] Mint: ${mint.publicKey.toBase58()}`);

  // ── Create associated token accounts ──────────────────────────────────────
  // We create wallets for each ATA so they're distinct accounts
  console.log(`\n[bootstrap] Creating ${NUM_ACCOUNTS} token accounts…`);
  const tokenAccountPubkeys: string[] = [];

  // Process in batches of 5 to avoid tx size limits
  const BATCH = 5;
  for (let i = 0; i < NUM_ACCOUNTS; i += BATCH) {
    const batchWallets: Keypair[] = [];
    const ataAddresses: PublicKey[] = [];

    for (let j = i; j < Math.min(i + BATCH, NUM_ACCOUNTS); j++) {
      const wallet = Keypair.generate();
      const ata = await getAssociatedTokenAddress(
        mint.publicKey,
        wallet.publicKey,
        false,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      batchWallets.push(wallet);
      ataAddresses.push(ata);
    }

    const tx = new Transaction();

    // Fund each wallet minimally (so the ATA creation doesn't fail due to no rent)
    for (const wallet of batchWallets) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: wallet.publicKey,
          lamports: 0.002 * LAMPORTS_PER_SOL,
        })
      );
    }

    // Create each ATA
    for (let k = 0; k < batchWallets.length; k++) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          ataAddresses[k],
          batchWallets[k].publicKey,
          mint.publicKey,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }

    // Mint some tokens into each ATA
    for (const ata of ataAddresses) {
      tx.add(
        createMintToInstruction(
          mint.publicKey,
          ata,
          payer.publicKey,
          1_000_000n, // 1 token at 6 decimals
          [],
          TOKEN_PROGRAM_ID
        )
      );
    }

    await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: "confirmed",
    });

    for (const ata of ataAddresses) {
      tokenAccountPubkeys.push(ata.toBase58());
      console.log(`  [${tokenAccountPubkeys.length.toString().padStart(2, "0")}] ${ata.toBase58()}`);
    }
  }

  // ── Upsert into Supabase ───────────────────────────────────────────────────
  const supabase = createSupabaseServiceClient();
  const rows = tokenAccountPubkeys.map((pubkey) => ({ [TOKEN_COLUMN]: pubkey }));

  const { error } = await supabase
    .from(TOKEN_TABLE)
    .upsert(rows, { onConflict: TOKEN_COLUMN, ignoreDuplicates: false });

  if (error) {
    throw new Error(
      `Failed to upsert token accounts into table "${TOKEN_TABLE}": ${error.message} (code: ${error.code})`
    );
  }

  console.log(`\n[bootstrap] Upserted ${rows.length} token accounts into Supabase table "${TOKEN_TABLE}"`);
  console.log(`[bootstrap] Done! Run: npm run dev`);
}

main().catch((err) => {
  console.error("[bootstrap] Fatal:", String(err));
  process.exit(1);
});
