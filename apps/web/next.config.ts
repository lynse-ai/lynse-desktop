import type { NextConfig } from "next";
import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";

const privateRecordingCardInputs = [
  "./app/plugins/(private-plugins)/recording-card/page.tsx",
  "./app/api/(private-plugins)/recording-card/ownership/route.ts",
  "./app/api/(private-plugins)/recording-card/ownership/verify.wasm",
  "../../packages/views/recording-card-private/index.ts",
].map((path) => existsSync(new URL(path, import.meta.url)));
if (
  (privateRecordingCardInputs.some(Boolean) || process.env.LYNSE_REQUIRE_PRIVATE_RECORDING_CARD === "1") &&
  !privateRecordingCardInputs.every(Boolean)
) {
  throw new Error("The private recording card plugin requires both web routes, the verifier, and shared views");
}

// The web build inlines its own package version so the About panel can show
// it (desktop reads the version from the Rust host bridge instead).
const webPkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

// The assistant IP GIFs are owned by the desktop app (apps/tauri/public/
// assistant) but rendered by shared views code in the web app too. Next serves
// public/ assets from this app's directory, so mirror them here on every dev
// or build run. The copies stay untracked (see .gitignore) — the single
// source of truth stays in the desktop app.
const assistantGifSrc = new URL("../tauri/public/assistant", import.meta.url);
const assistantGifDest = new URL("./public/assistant", import.meta.url);
if (existsSync(assistantGifSrc)) {
  mkdirSync(assistantGifDest, { recursive: true });
  cpSync(assistantGifSrc, assistantGifDest, { recursive: true });
}

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
