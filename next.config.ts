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
  async redirects() {
    return [
      // `/automation` was the v1 AgentsWarRoom page. v3 replaces it with
      // `/team` (Your AI Team). Keep the redirect so existing bookmarks
      // and external links don't 404. The nav-items alias renders the
      // correct "Your AI Team" label during the redirect flash.
      {
        source: '/automation',
        destination: '/team',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
