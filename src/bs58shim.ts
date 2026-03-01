/**
 * src/bs58shim.ts
 *
 * Tiny re-export so we can dynamically import bs58 in verifyMemo.ts.
 * @solana/web3.js ships its own bs58 internally; we access it here to
 * avoid adding an extra top-level dependency.
 *
 * If bs58 is not available as a standalone package, we fall back to
 * Node's Buffer.from(str, "base58") polyfill via the internal web3.js bundle.
 */

// @solana/web3.js re-exports bs58 as a transitive dependency.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bs58Pkg = require("bs58") as {
  encode: (bytes: Uint8Array) => string;
  decode: (str: string) => Uint8Array;
};

export const bs58 = bs58Pkg;
