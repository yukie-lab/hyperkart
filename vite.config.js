import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5178, strictPort: true },
  build: {
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
  },
});
