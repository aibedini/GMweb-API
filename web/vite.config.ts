import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

// ADR-004: independent web app INSIDE GMweb-API — own artifact, own CI, own
// deploy. Same repository ≠ same runtime. Build output goes to
// ../public/web-app which the Fastify server serves under /web.
const here = path.dirname(fileURLToPath(import.meta.url));
const apiPackage = JSON.parse(fs.readFileSync(path.resolve(here, "../package.json"), "utf8")) as { version: string };

// Build provenance. Two builds can share a semantic version, so the revision is
// what actually distinguishes them; the API reads this file from disk and never
// shells out to git on a request. Captured ONCE, here, at build time.
function buildRevision(): string {
  const fromEnv = process.env.GMWEB_BUILD_REVISION;
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(here, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return ""; // no git (tarball build): version comparison stays valid
  }
}

const BUILD_INFO = {
  version: apiPackage.version,
  revision: buildRevision(),
  builtAt: new Date().toISOString(),
};

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
        // version.json stays exactly the shape consumers already read; the
        // provenance rides alongside it so nothing existing breaks.
        this.emitFile({
          type: "asset",
          fileName: "version.json",
          source: `${JSON.stringify({ version: apiPackage.version }, null, 2)}\n`,
        });
        this.emitFile({
          type: "asset",
          fileName: "build-info.json",
          source: `${JSON.stringify(BUILD_INFO, null, 2)}\n`,
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
