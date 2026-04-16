import type { NextConfig } from 'next';

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

const internalApiOrigin = stripTrailingSlash(
  process.env.NEXT_SERVER_API_URL ||
    process.env.INTERNAL_API_ORIGIN ||
    (process.env.NODE_ENV === 'development' ? 'http://localhost:8000' : 'http://backend:8000'),
);

const nextConfig: NextConfig = {
  experimental: {
    proxyClientMaxBodySize: '1gb',
  },
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${internalApiOrigin}/api/:path*` },
      { source: '/ws/:path*', destination: `${internalApiOrigin}/ws/:path*` },
    ];
  },
};

export default nextConfig;
