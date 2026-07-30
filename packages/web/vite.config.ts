import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Point at core's source rather than its build output, so the UI picks up
      // engine changes without a build step in between.
      '@query-not/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // The agent holds the database connection; the UI never talks to Postgres.
      '/api': {
        target: process.env['QUERYNOT_AGENT_URL'] ?? 'http://localhost:5174',
        changeOrigin: true,
      },
    },
  },
});
