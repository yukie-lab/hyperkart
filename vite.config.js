import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5178, strictPort: true },
  build: {
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      // One IIFE rather than an ES module, so `tools/singlefile.mjs` can inline
      // it as a classic <script>. A module script is blocked by CORS when the
      // page is opened from file://, which is the whole reason a single-file
      // build exists — there is no code splitting to lose here anyway, the game
      // is one entry with no dynamic imports.
      output: { format: 'iife', inlineDynamicImports: true },
    },
  },
});
