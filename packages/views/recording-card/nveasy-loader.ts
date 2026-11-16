import type { NvEasyClientConstructor } from "./nveasy-types";

/**
 * Runtime loader for the obfuscated NvEasy WebUSB SDK bundle.
 *
 * The bundle is vendor code without a license file, so it never enters this
 * public repository: a copy is uploaded to the same CloudBase static hosting
 * that serves the plugin catalog, and this loader fetches the text, wraps it
 * in a Blob URL and native-imports it (skipping the bundler entirely). The
 * constructor is cached module-wide; a failed load clears the promise so a
 * retry actually re-fetches.
 */

// Versioned path — bump when the vendor SDK updates so browsers skip the old
// cached copy. Hosted next to plugins/catalog.json (same CloudBase env).
const SDK_URL =
  "https://lynse-d8g49o1i956741f9e-1401959758.tcloudbaseapp.com/vendor/nveasy-webusb/1.0.0/index.js";

let cached: NvEasyClientConstructor | null = null;
let pending: Promise<NvEasyClientConstructor> | null = null;

export async function loadNvEasyClient(): Promise<NvEasyClientConstructor> {
  if (cached) return cached;
  if (!pending) {
    pending = fetchAndImport().then((ctor) => {
      cached = ctor;
      return ctor;
    });
    // A rejected load must not poison future retries.
    pending.catch(() => {
      pending = null;
    });
  }
  return pending;
}

async function fetchAndImport(): Promise<NvEasyClientConstructor> {
  const response = await fetch(SDK_URL);
  if (!response.ok) {
    throw new Error(`NvEasy SDK download failed: HTTP ${response.status}`);
  }
  const source = await response.text();
  const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    // webpackIgnore makes the bundler emit a native dynamic import; the Blob
    // URL keeps the vendor bundle out of the build graph.
    const mod = (await import(/* webpackIgnore: true */ blobUrl)) as {
      NvEasyClient?: unknown;
    };
    const ctor = mod.NvEasyClient;
    if (typeof ctor !== "function") {
      throw new Error("NvEasy SDK bundle did not export NvEasyClient");
    }
    return ctor as NvEasyClientConstructor;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
