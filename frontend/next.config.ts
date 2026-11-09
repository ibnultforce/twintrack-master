import type { NextConfig } from 'next';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL;

const nextConfig: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  allowedDevOrigins: ['twintrack.localhost'],
  // The API rejects these addresses, and the session cookie can't reach it from them, so send people to the real one.
  async redirects() {
    if (!APP_URL) return [];
    return [{
      source: '/:path*',
      has: [{ type: 'host', value: 'localhost|127\\.0\\.0\\.1' }],
      destination: `${APP_URL}/:path*`,
      permanent: false,
    }];
  },
};

export default nextConfig;
