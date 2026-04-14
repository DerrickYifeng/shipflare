import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['ioredis', 'bullmq', 'postgres'],
  devIndicators: false,
};

export default nextConfig;
