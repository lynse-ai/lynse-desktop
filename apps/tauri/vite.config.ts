import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const privatePlugins = new URL("./src/private-plugins/index.ts", import.meta.url);
const hasPrivatePlugins = existsSync(privatePlugins);
const hasPrivateBackend = existsSync(new URL("./src-tauri/src/recording_card_private/mod.rs", import.meta.url));
if (hasPrivatePlugins !== hasPrivateBackend || (!hasPrivatePlugins && process.env.LYNSE_REQUIRE_PRIVATE_RECORDING_CARD === "1")) {
  throw new Error("The private recording card plugin requires both desktop inputs");
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 5174,
    strictPort: true,
  },
  optimizeDeps: {
    // Keep dependency scanning out of Rust build artifacts and test symlinks.
    entries: ["index.html", "onboarding-preview.html", "permission-preview.html"],
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: hasPrivatePlugins
      ? [{ find: /^\.\/private-plugins$/, replacement: fileURLToPath(privatePlugins) }]
      : [],
  },
  define: {
    // Edition split (see core/config): `LYNSE_EDITION=cn|intl` allows explicitly pinning
    // an edition at build time; unconfigured builds leave it unset for runtime detection.
    __LYNSE_EDITION__: JSON.stringify(process.env.LYNSE_EDITION ?? ""),
    __LYNSE_DEV__: JSON.stringify(process.env.NODE_ENV !== "production"),
  },
});
