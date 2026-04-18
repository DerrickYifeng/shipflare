import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Pin the workspace root so Next doesn't walk up the tree and pick a
  // stray lockfile in a parent directory as the root.
  turbopack: {
    root: path.dirname(fileURLToPath(import.meta.url)),
  },
  serverExternalPackages: ['ioredis', 'bullmq', 'postgres'],
  devIndicators: false,
};

export default nextConfig;
