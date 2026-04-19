import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Pin the workspace root so Next (webpack + turbopack) doesn't walk up
  // the tree and pick a stray lockfile in a parent directory as the root.
  outputFileTracingRoot: projectRoot,
  turbopack: {
    root: projectRoot,
  },
  serverExternalPackages: ['ioredis', 'bullmq', 'postgres'],
  devIndicators: false,
};

export default nextConfig;
