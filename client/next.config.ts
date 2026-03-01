import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Silence the lockfile workspace warning
  turbopack: {},
};

export default nextConfig;
