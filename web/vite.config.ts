import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locked down in the build, open in dev.
 *
 * The token lives in localStorage, so cross-site scripting is the one threat that matters, and
 * this is the mitigation: no script from anywhere but this origin, no connection to anywhere but
 * this origin, and images only from here and the OpenStreetMap tile servers. It cannot be applied
 * in dev because the React plugin injects an inline preamble for fast refresh, which this forbids.
 */
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function cspOnBuild(): Plugin {
  return {
    name: 'csp-on-build',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

export default defineConfig({
  plugins: [react(), cspOnBuild()],
  resolve: {
    // The API contract is one file in the Nest tree; see src/ui-api/api-types.ts.
    alias: { '@shared': resolve(here, '../src/ui-api') },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
    // Vite refuses to serve files outside its root unless told; the shared types are one level up.
    fs: { allow: [resolve(here, '..')] },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  test: { environment: 'node', include: ['src/**/*.spec.ts'] },
});
