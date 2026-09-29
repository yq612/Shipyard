import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.API_TARGET ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Keep the browser's Host header (no changeOrigin): the API checks that
    // Origin and Host match for writes.
    proxy: { "/api": { target: apiTarget } },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
