import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ADR-004: independent web app INSIDE GMweb-API — own artifact, own CI, own
// deploy. Same repository ≠ same runtime. Build output goes to
// ../public/web-app which the Fastify server serves under /web.
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "/web/",
  plugins: [react(), tailwindcss()],
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
