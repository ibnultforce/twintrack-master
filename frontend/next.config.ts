import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  allowedDevOrigins: ['twintrack.localhost'],
};

export default nextConfig;
