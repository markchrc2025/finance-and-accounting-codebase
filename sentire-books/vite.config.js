/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // jsPDF has optional peer deps (canvg, dompurify) not needed for our usage
      external: ['canvg', 'dompurify'],
    },
  },
  optimizeDeps: {
    include: ['jspdf', 'html2canvas'],
  },
  // Portal test harness (Track B). Runs under jsdom; no network, no backend.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/trackB.setup.js'],
    css: false,
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
