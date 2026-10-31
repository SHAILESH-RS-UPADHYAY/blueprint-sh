import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  // Vercel serves the plain Vite build from dist/; everywhere else the Cloudflare build output is used.
  plugins: process.env.VERCEL ? [] : [cloudflare()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
