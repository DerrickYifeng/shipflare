import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['ioredis', 'bullmq', 'postgres'],
};

export default nextConfig;
