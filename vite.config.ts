import { defineConfig } from 'vite';

export default defineConfig({
  // Where the site is served from. GitHub Pages serves project sites under
  // /<repo>/, so the deploy workflow sets BASE_PATH=/rebuild-sim/; locally it's /.
  base: process.env.BASE_PATH || '/',
  server: { port: 5173 },
  // rapier3d-compat inlines its wasm, so the bundle is large by design.
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
});
