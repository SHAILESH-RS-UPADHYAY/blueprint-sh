import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [cloudflare()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
