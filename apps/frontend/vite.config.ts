import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardIntro } from "./src/components/layout/DashboardIntro";

const siteUrl = "https://dashboard.quip.network/";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "dashboard-seo",
      transformIndexHtml() {
        return [
          // Preserve crawlable/no-JS content inside the app root. createRoot
          // replaces it with the same component when the dashboard mounts.
          {
            tag: "div",
            attrs: { id: "root" },
            children: renderToStaticMarkup(createElement(DashboardIntro)),
            injectTo: "body-prepend",
          },
          { tag: "link", attrs: { rel: "canonical", href: siteUrl } },
          {
            tag: "script",
            attrs: { type: "application/ld+json" },
            children: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebSite",
              name: "Quip Mining Telemetry Dashboard",
              url: siteUrl,
            }),
          },
        ];
      },
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "robots.txt",
          source: `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}sitemap.xml\n`,
        });
        this.emitFile({
          type: "asset",
          fileName: "sitemap.xml",
          source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${siteUrl}</loc></url>\n</urlset>\n`,
        });
      },
    },
  ],
  build: {
    // Emit .vite/manifest.json so the bundle test asserts graph reachability
    // from the module manifest instead of scanning minified JS substrings.
    manifest: true,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // Listen on all interfaces so the container's port is reachable from the
    // host, and proxy the API to the Rust backend. Defaults to a local
    // backend (see deploy/docker-compose.yml); override
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
