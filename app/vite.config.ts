import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_COYOTE_API_TARGET ?? "http://127.0.0.1:8787";

export default defineConfig({
  root: "src-ui",
  base: process.env.VITE_BASE ?? "/ui/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      "/health": apiTarget,
      "/status": apiTarget,
      "/ui/state": apiTarget,
      // Server-sent events: buffering here would defeat the point.
      "/ui/stream": { target: apiTarget, changeOrigin: false, ws: false },
      "/ui/start": apiTarget,
      "/ui/stop": apiTarget,
      "/ui/disconnect": apiTarget,
      "/ui/settings": apiTarget,
      "/ui/upstream": apiTarget,
      "/ui/waveforms": apiTarget,
      "/ui/test-shock": apiTarget,
      "/ui/qr.svg": apiTarget,
      "/control": apiTarget,
      "/dglab": apiTarget,
      "/events": apiTarget,
      "/shock": apiTarget
    }
  }
});
