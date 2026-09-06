import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api/segmentation': 'http://127.0.0.1:8008' },
    port: 5173,
    host: '127.0.0.1'
  },
  preview: {
    proxy: { '/api/segmentation': 'http://127.0.0.1:8008' },
    port: 5173,
    host: '127.0.0.1'
  }
});
