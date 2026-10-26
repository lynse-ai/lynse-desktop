import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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
  },
  define: {
    // Edition split (see core/config): `LYNSE_EDITION=cn|intl` picks the
    // connector set baked into the build; unconfigured builds default to cn.
    __LYNSE_EDITION__: JSON.stringify(process.env.LYNSE_EDITION ?? "cn"),
    __LYNSE_DEV__: JSON.stringify(process.env.NODE_ENV !== "production"),
  },
});
