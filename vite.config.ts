import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  // rapier3d-compat inlines its wasm, so the bundle is large by design.
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
});
