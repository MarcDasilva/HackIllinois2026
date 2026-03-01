/**
 * src/verifyMemo.ts
 *
 * CLI script: fetch a transaction by signature and verify its LAVA_V1 memo.
 *
 * Usage:
 *   npm run verify -- <signature>
 *   npx ts-node src/verifyMemo.ts <signature>
 */

import "dotenv/config";
import { ParsedTransactionWithMeta } from "@solana/web3.js";
import { createConnection } from "./solana";
import { parseMemoContent, MEMO_PROGRAM_ID } from "./memoCommit";

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const sig = process.argv[2];

  if (!sig || sig.trim().length === 0) {
    console.error("Usage: npm run verify -- <transaction-signature>");
    process.exit(1);
  }

  const connection = createConnection();
  const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";

  console.log(`\n[verifyMemo] RPC: ${rpcUrl}`);
  console.log(`[verifyMemo] Fetching transaction: ${sig}\n`);

  let tx: ParsedTransactionWithMeta | null;
  try {
    tx = await connection.getParsedTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch (err) {
    console.error(`[verifyMemo] RPC error fetching transaction: ${String(err)}`);
    process.exit(1);
  }

  if (!tx) {
    console.error(`[verifyMemo] Transaction not found: ${sig}`);
    console.error(
      "  - Is this the correct signature?\n" +
        "  - Did you specify the correct cluster? (Set SOLANA_RPC_URL)\n" +
        "  - The transaction may not be confirmed yet — try again in a moment."
    );
    process.exit(1);
  }

  // ── Transaction metadata ───────────────────────────────────────────────────
  const slot = tx.slot;
  const blockTime = tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : "unknown";
  const err = tx.meta?.err;

  console.log("── Transaction Info ───────────────────────────────────────────");
  console.log(`  Signature : ${sig}`);
  console.log(`  Slot      : ${slot}`);
  console.log(`  Block time: ${blockTime}`);
  console.log(`  Status    : ${err ? `FAILED — ${JSON.stringify(err)}` : "SUCCESS"}`);
  console.log(`  Explorer  : https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  if (err) {
    console.error("\n[verifyMemo] Transaction failed on-chain; no memo to verify.");
    process.exit(1);
  }

  // ── Find Memo instruction ──────────────────────────────────────────────────
  const instructions = tx.transaction.message.instructions;
  const memoProgramId = MEMO_PROGRAM_ID.toBase58();

  const memoInstructions = instructions.filter((ix) => {
    if ("parsed" in ix) {
      // ParsedInstruction
      return ix.programId.toBase58() === memoProgramId;
    }
    // PartiallyDecodedInstruction
    return ix.programId.toBase58() === memoProgramId;
  });

  if (memoInstructions.length === 0) {
    console.error(
      `\n[verifyMemo] No Memo instruction found in this transaction.\n` +
        `  Expected program: ${memoProgramId}`
    );
    process.exit(1);
  }

  // ── Extract memo data ──────────────────────────────────────────────────────
  // The memo text is surfaced in tx.meta.logMessages for Memo v2
  const logMessages = tx.meta?.logMessages ?? [];
  const memoLogLine = logMessages.find((line) =>
    line.includes("Program log: Memo")
  );

  let memoText: string | null = null;

  if (memoLogLine) {
    // Format: "Program log: Memo (len 123): \"LAVA_V1|...\""
    const match = memoLogLine.match(/Memo \(len \d+\): "(.+)"$/);
    if (match) memoText = match[1];
  }

  // Fallback: try PartiallyDecodedInstruction.data (base58 encoded)
  if (!memoText) {
    const partialIx = memoInstructions[0];
    if ("data" in partialIx && typeof partialIx.data === "string") {
      try {
        // Solana base58-encodes raw instruction data
        const { bs58 } = await import("./bs58shim");
        const decoded = bs58.decode(partialIx.data);
        memoText = Buffer.from(decoded).toString("utf8");
      } catch {
        // ignore decode errors
      }
    }
  }

  if (!memoText) {
    console.error(
      "\n[verifyMemo] Could not extract memo text from transaction logs."
    );
    console.log("\nRaw log messages:");
    logMessages.forEach((l) => console.log(" ", l));
    process.exit(1);
  }

  console.log("\n── Raw Memo Content ───────────────────────────────────────────");
  console.log(`  ${memoText}`);

  // ── Parse LAVA_V1 ──────────────────────────────────────────────────────────
  const parsed = parseMemoContent(memoText);

  if (!parsed) {
    console.error(
      "\n[verifyMemo] Memo does not match LAVA_V1 format.\n" +
        `  Expected: LAVA_V1|slot=...|blockhash=...|tokens=...|docs=...|n=...|seed=...`
    );
    process.exit(1);
  }

  console.log("\n── Parsed LAVA_V1 Fields ──────────────────────────────────────");
  console.log(`  version           : ${parsed.version}`);
  console.log(`  slot              : ${parsed.slot}`);
  console.log(`  blockhash         : ${parsed.blockhash}`);
  console.log(`  tokens_state_hash : ${parsed.tokens_state_hash}`);
  console.log(`  docs_hash         : ${parsed.docs_hash}`);
  console.log(`  doc_count         : ${parsed.doc_count}`);
  console.log(`  entropy_seed      : ${parsed.entropy_seed}`);

  // ── Format validation ──────────────────────────────────────────────────────
  const issues: string[] = [];

  if (!/^[0-9a-f]{64}$/.test(parsed.tokens_state_hash)) {
    issues.push(`tokens_state_hash is not a 64-char hex string: "${parsed.tokens_state_hash}"`);
  }
  if (!/^[0-9a-f]{64}$/.test(parsed.docs_hash)) {
    issues.push(`docs_hash is not a 64-char hex string: "${parsed.docs_hash}"`);
  }
  if (!/^[0-9a-f]{64}$/.test(parsed.entropy_seed)) {
    issues.push(`entropy_seed is not a 64-char hex string: "${parsed.entropy_seed}"`);
  }
  if (parsed.slot <= 0) {
    issues.push(`slot must be a positive integer; got ${parsed.slot}`);
  }
  if (parsed.blockhash.length < 32) {
    issues.push(`blockhash looks too short: "${parsed.blockhash}"`);
  }

  console.log("\n── Validation ─────────────────────────────────────────────────");
  if (issues.length === 0) {
    console.log("  All checks passed.");
  } else {
    issues.forEach((issue) => console.error(`  FAIL: ${issue}`));
    process.exit(1);
  }

  console.log("\n[verifyMemo] Verification complete.\n");
}

main().catch((err) => {
  console.error("[verifyMemo] Unexpected error:", String(err));
  process.exit(1);
});
