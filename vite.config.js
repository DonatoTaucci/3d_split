import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  optimizeDeps: {
    exclude: ['manifold-3d'],
  },
  server: { host: true },
});
