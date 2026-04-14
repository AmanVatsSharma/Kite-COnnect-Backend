import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const repoRoot = path.resolve(__dirname, '../..');
  const env = loadEnv(mode, repoRoot, '');
  const apiPort = env.PORT || '3000';
  const target = `http://127.0.0.1:${apiPort}`;

  return {
    plugins: [react()],
    base: '/dashboard/',
    build: {
      outDir: '../../src/public/dashboard',
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      // Redirect root → /dashboard/ so localhost:5173/ works in dev
      open: '/dashboard/',
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
        },
        // Proxy /ws native WebSocket (needed if dashboard ever streams ticks directly)
        '/ws': {
          target: target.replace('http', 'ws'),
          ws: true,
          changeOrigin: true,
        },
        // Proxy Socket.IO transport (market-data namespace)
        '/socket.io': {
          target,
          ws: true,
          changeOrigin: true,
        },
      },
    },
  };
});
