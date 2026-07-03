import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // Listen on all interfaces so the container's port is reachable from the
    // host, and proxy the API to the hono server. Defaults to the sidecar
    // server in the dev container (see deploy/docker-compose.yml); override
    // VITE_API_PROXY to point at another running dashboard (e.g. a live node's
    // caddy endpoint) when confirming UI changes against real data.
    host: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY ?? "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
});
