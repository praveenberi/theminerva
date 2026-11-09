/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const api = process.env.VITE_API_PROXY ?? 'http://localhost:4000';
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: {
      '/api': api, '/uploads': api, '/sitemap.xml': api, '/robots.txt': api,
      '/ws': { target: api.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    sourcemap: false,
    rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom', 'react-router-dom'], charts: ['recharts'], motion: ['motion/react'] } } },
  },
  test: { environment: 'jsdom', globals: true, setupFiles: ['src/test/setup.ts'], css: false, exclude: ['e2e/**', 'node_modules/**'] },
});
