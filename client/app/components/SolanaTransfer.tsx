"use client";

/**
 * SolanaTransfer.tsx
 *
 * UI component: send SOL from the connected wallet to any address.
 *
 * Features:
 *  - WalletMultiButton (connect / disconnect / switch wallet)
 *  - Shows connected wallet address + live devnet balance
 *  - Form: recipient address + amount in SOL
 *  - Builds, signs, and sends a transfer tx via wallet adapter
 *  - Shows tx signature with Solana Explorer link on success
 *  - All errors are surfaced inline (no unhandled rejections)
 *
 * Props:
 *  - onTransferComplete?: (signature: string) => void
 *    Called after a successful on-chain confirmation.
 */

import { useState, useCallback, useEffect } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

interface Props {
  onTransferComplete?: (signature: string) => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading"; message: string }
  | { kind: "success"; signature: string }
  | { kind: "error"; message: string };

const EXPLORER_BASE = "https://explorer.solana.com/tx";
const CLUSTER = process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? "devnet";

function explorerUrl(sig: string) {
  return `${EXPLORER_BASE}/${sig}?cluster=${CLUSTER}`;
}

function shortenAddress(addr: string) {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export default function SolanaTransfer({ onTransferComplete }: Props) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // Fetch balance whenever the wallet or connection changes
  useEffect(() => {
    if (!publicKey) {
      setBalance(null);
      return;
    }

    let cancelled = false;

    async function fetchBalance() {
      if (!publicKey) return;
      try {
        const lamports = await connection.getBalance(publicKey);
        if (!cancelled) setBalance(lamports / LAMPORTS_PER_SOL);
      } catch {
        if (!cancelled) setBalance(null);
      }
    }

    fetchBalance();

    // Poll every 10s so balance stays fresh
    const interval = setInterval(fetchBalance, 10_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [publicKey, connection]);

  const handleSend = useCallback(async () => {
    if (!publicKey) return;

    // ── Validate inputs ────────────────────────────────────────────────────
    let recipientPubkey: PublicKey;
    try {
      recipientPubkey = new PublicKey(recipient.trim());
    } catch {
      setStatus({ kind: "error", message: "Invalid recipient address." });
      return;
    }

    const sol = parseFloat(amount);
    if (isNaN(sol) || sol <= 0) {
      setStatus({ kind: "error", message: "Enter a positive SOL amount." });
      return;
    }

    if (balance !== null && sol > balance) {
      setStatus({
        kind: "error",
        message: `Insufficient balance. You have ${balance.toFixed(4)} SOL.`,
      });
      return;
    }

    // ── Build transaction ──────────────────────────────────────────────────
    setStatus({ kind: "loading", message: "Awaiting wallet approval…" });

    try {
      const lamports = Math.round(sol * LAMPORTS_PER_SOL);
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");

      const tx = new Transaction({
        recentBlockhash: blockhash,
        feePayer: publicKey,
      }).add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: recipientPubkey,
          lamports,
        })
      );

      setStatus({ kind: "loading", message: "Sending transaction…" });

      const signature = await sendTransaction(tx, connection);

      setStatus({ kind: "loading", message: "Confirming on-chain…" });

      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      setStatus({ kind: "success", signature });
      onTransferComplete?.(signature);

      // Refresh balance after send
      const lamportsAfter = await connection.getBalance(publicKey);
      setBalance(lamportsAfter / LAMPORTS_PER_SOL);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Transaction failed.";
      setStatus({ kind: "error", message: msg });
    }
  }, [publicKey, recipient, amount, balance, connection, sendTransaction, onTransferComplete]);

  const reset = () => {
    setStatus({ kind: "idle" });
    setRecipient("");
    setAmount("");
  };

  return (
    <div className="rounded-2xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-6 shadow-sm space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            Solana Transfer
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            Send SOL on {CLUSTER}
          </p>
        </div>
        <WalletMultiButton style={{}} />
      </div>

      {/* Wallet info */}
      {connected && publicKey && (
        <div className="flex items-center justify-between rounded-lg bg-zinc-50 dark:bg-zinc-800 px-4 py-3 text-sm">
          <span className="font-mono text-zinc-600 dark:text-zinc-300">
            {shortenAddress(publicKey.toBase58())}
          </span>
          <span className="font-semibold text-zinc-900 dark:text-zinc-100">
            {balance !== null ? `${balance.toFixed(4)} SOL` : "—"}
          </span>
        </div>
      )}

      {!connected && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center py-2">
          Connect your wallet to send SOL.
        </p>
      )}

      {/* Form */}
      {connected && status.kind !== "success" && (
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
              Recipient address
            </label>
            <input
              type="text"
              placeholder="Solana public key (base58)"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              disabled={status.kind === "loading"}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm font-mono placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-50"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
              Amount (SOL)
            </label>
            <input
              type="number"
              placeholder="0.01"
              min="0"
              step="0.001"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={status.kind === "loading"}
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-3 py-2 text-sm placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-50"
            />
          </div>

          {/* Error */}
          {status.kind === "error" && (
            <p className="text-xs text-red-500 dark:text-red-400">
              {status.message}
            </p>
          )}

          <button
            onClick={handleSend}
            disabled={status.kind === "loading" || !recipient || !amount}
            className="w-full rounded-lg bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold py-2.5 transition-colors"
          >
            {status.kind === "loading" ? status.message : "Send SOL"}
          </button>
        </div>
      )}

      {/* Success */}
      {status.kind === "success" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-lg bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-700 px-4 py-3">
            <span className="text-emerald-600 dark:text-emerald-400 text-lg">✓</span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
                Transfer confirmed
              </p>
              <p className="text-xs font-mono text-emerald-600 dark:text-emerald-400 truncate">
                {status.signature}
              </p>
            </div>
          </div>

          <div className="flex gap-2">
            <a
              href={explorerUrl(status.signature)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 text-center rounded-lg border border-zinc-300 dark:border-zinc-600 text-sm py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors text-zinc-700 dark:text-zinc-300"
            >
              View on Explorer
            </a>
            <button
              onClick={reset}
              className="flex-1 rounded-lg bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold py-2 transition-colors"
            >
              Send another
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
