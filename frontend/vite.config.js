import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, /api is proxied to the Express backend so the browser never hits CORS.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': { target: process.env.VITE_BACKEND_URL || 'http://localhost:5001', changeOrigin: true },
    },
  },
  build: { chunkSizeWarningLimit: 900 },
});
