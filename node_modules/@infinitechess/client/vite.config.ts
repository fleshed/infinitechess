import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '../..');

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(repoRoot, 'packages/shared/src'),
      '@infinitechess/shared': resolve(repoRoot, 'packages/shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    fs: { allow: [repoRoot] },
    proxy: {
      '/socket.io': {
        target: 'http://localhost:8080',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
