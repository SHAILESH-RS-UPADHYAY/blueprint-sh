import { defineConfig } from 'cf/config';

// Assets-only Worker: the Vite client build is the whole site.
export default defineConfig({
  worker: {
    name: 'blueprint-sh',
    compatibilityDate: '2026-10-23',
    observability: { enabled: true },
    assets: { notFoundHandling: 'single-page-application' },
  },
});
