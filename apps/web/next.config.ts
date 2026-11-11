import type { NextConfig } from "next";
import { readFileSync } from "node:fs";

// The web build inlines its own package version so the About panel can show
// it (desktop reads the version from the Rust host bridge instead).
const webPkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_APP_VERSION: webPkg.version,
  },
  transpilePackages: ["@lynse/core", "@lynse/ui", "@lynse/views"],
  // The www.lynse.ai deployment serves the app under the /app subpath of the
  // marketing site's origin (same-origin requirement of the MCP bridge).
  // Build-time env keeps local dev and other shells on the root path.
  ...(process.env.NEXT_PUBLIC_BASE_PATH ? { basePath: process.env.NEXT_PUBLIC_BASE_PATH } : {}),
  // Deployment target runs `node server.js` from the standalone bundle inside
  // a slim Node container (see deploy/www-lynse-ai/).
  ...(process.env.NEXT_PUBLIC_BASE_PATH ? { output: "standalone" as const } : {}),
};

export default nextConfig;
