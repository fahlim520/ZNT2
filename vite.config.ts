import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Electron loads the renderer with file://, so bundled assets must use
  // relative URLs instead of absolute /assets/... paths.
  base: './',
  plugins: [react()],
  build: { outDir: 'dist' },
});
