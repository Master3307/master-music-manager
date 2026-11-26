import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900, sourcemap: false },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4545', changeOrigin: false, ws: true },
      '/share': 'http://127.0.0.1:4545',
      '/dav': 'http://127.0.0.1:4545',
    },
  },
});
