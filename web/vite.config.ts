import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  publicDir: resolve(__dirname, 'public'),
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        offline: resolve(__dirname, 'offline.html'),
      },
    },
  },
});
