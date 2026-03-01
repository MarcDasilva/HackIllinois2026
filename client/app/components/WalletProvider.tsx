"use client";

/**
 * WalletProvider.tsx
 *
 * Wraps the app with Solana wallet adapter context.
 * Must be a client component — wallet adapters rely on browser APIs.
 *
 * Supported wallets: Phantom, Solflare, Backpack.
 * Network: configurable via NEXT_PUBLIC_SOLANA_NETWORK (default: devnet).
 */

import { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";

// Default wallet adapter UI styles
import "@solana/wallet-adapter-react-ui/styles.css";

const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ??
  clusterApiUrl("devnet");

export default function WalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
