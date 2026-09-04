import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

// ADR-004: independent web app INSIDE GMweb-API — own artifact, own CI, own
// deploy. Same repository ≠ same runtime. Build output goes to
// ../public/web-app which the Fastify server serves under /web.
const here = path.dirname(fileURLToPath(import.meta.url));
const apiPackage = JSON.parse(fs.readFileSync(path.resolve(here, "../package.json"), "utf8")) as { version: string };

export default defineConfig({
  base: "/web/",
  define: {
    __GMWEB_VERSION__: JSON.stringify(apiPackage.version),
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "gmweb-pwa-build-info",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: `${JSON.stringify({ version: apiPackage.version }, null, 2)}\n`,
        });
      },
    },
  ],
  resolve: {
    alias: { "@": path.resolve(here, "./src") },
  },
  build: {
    outDir: path.resolve(here, "../public/web-app"),
    emptyOutDir: true,
  },
  server: {
    // `npm run dev` inside web/ proxies /api to a running GMweb API so the
    // sync engine talks to real endpoints without CORS pain.
    proxy: {
      "/api": "http://127.0.0.1:3030",
    },
  },
});
