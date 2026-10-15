import path from 'node:path';
import { staticSecurityHeaders } from './security.mjs';

const WORKSPACE_PACKAGES = ['@typease/ui', '@typease/branding', '@typease/api-client', '@typease/types', '@typease/validation', '@typease/permissions'];

/**
 * The Next.js configuration every TypEase web app starts from.
 *
 *   // apps/<app>/next.config.mjs
 *   import { createNextConfig } from '@typease/config/next.mjs';
 *   export default createNextConfig({ appDir: import.meta.dirname, camera: true });
 *
 * @param {{
 *   appDir: string,
 *   camera?: boolean,       // allow the device camera (document capture) in the Permissions-Policy
 *   apiProxy?: boolean,     // serve /api/v1/* from the app's own origin (portals on tenant domains: first-party cookies)
 *   extra?: import('next').NextConfig,
 * }} options
 * @returns {import('next').NextConfig}
 */
export function createNextConfig({ appDir, camera = false, apiProxy = false, extra = {} }) {
  const isDev = process.env.NODE_ENV !== 'production';
  const apiTarget = (process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
  return {
    output: 'standalone',
    // NEXT_DIST_DIR lets several builds / dev servers of the same app run side by side (CI, local tooling).
    distDir: process.env.NEXT_DIST_DIR || '.next',
    // The apps live in a monorepo: trace files from the repository root so the standalone bundle is complete.
    outputFileTracingRoot: path.join(appDir, '../../'),
    reactStrictMode: true,
    poweredByHeader: false,
    // Workspace packages are consumed from TypeScript source.
    transpilePackages: WORKSPACE_PACKAGES,
    // Type checking runs in `next build`; linting is a separate step of the repository (`pnpm lint`).
    eslint: { ignoreDuringBuilds: true },
    // Tenant portals are opened as <slug>.typease.localhost during development.
    allowedDevOrigins: ['*.typease.localhost', '*.localhost'],
    // The floating development badge covers the mobile tab bar and ends up in screenshots.
    devIndicators: false,
    // @typease/ui is one barrel file: let Next import only the modules a page uses.
    experimental: { optimizePackageImports: ['@typease/ui'] },
    async headers() {
      return [{ source: '/:path*', headers: staticSecurityHeaders({ camera, isDev }) }];
    },
    async rewrites() {
      return apiProxy ? [{ source: '/api/v1/:path*', destination: `${apiTarget}/api/v1/:path*` }] : [];
    },
    ...extra,
  };
}
