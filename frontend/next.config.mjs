import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Silence the "multiple lockfiles" workspace-root warning
  outputFileTracingRoot: __dirname,
  // GaussianSplats3D's sort worker transfers SharedArrayBuffers,
  // which requires cross-origin isolation on every page.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
      },
    ];
  },

  webpack(config) {
    // Prevent Next.js from trying to bundle the pre-compiled UMD/CJS
    // build of GaussianSplats3D through its own worker pipeline.
    config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    return config;
  },
};

export default nextConfig;
