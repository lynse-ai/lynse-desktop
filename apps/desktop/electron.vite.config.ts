import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";

const DEFAULT_API_URL = "http://119.97.160.133:10060";

/**
 * Vite plugin that adds a server-side proxy for API requests.
 * This replaces the Next.js /api/proxy route used in the web app,
 * forwarding requests to the actual Lynse backend.
 */
function apiProxyPlugin(): Plugin {
  return {
    name: "lynse-api-proxy",
    configureServer(server) {
      server.middlewares.use("/api/proxy", async (req, res, next) => {
        try {
          const targetUrl = (req.headers["x-lynse-api-url"] as string) || DEFAULT_API_URL;
          const path = req.url || "/";
          const upstream = `${targetUrl.replace(/\/+$/, "")}${path}`;

          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            const lower = key.toLowerCase();
            if (["host", "x-lynse-api-url", "accept-encoding", "connection", "keep-alive", "transfer-encoding"].includes(lower)) continue;
            if (typeof value === "string") headers[key] = value;
            else if (Array.isArray(value)) headers[key] = value.join(", ");
          }

          let body: Buffer | undefined;
          if (req.method !== "GET" && req.method !== "HEAD") {
            body = await new Promise<Buffer>((resolve, reject) => {
              const chunks: Buffer[] = [];
              req.on("data", (chunk: Buffer) => chunks.push(chunk));
              req.on("end", () => resolve(Buffer.concat(chunks)));
              req.on("error", reject);
            });
          }

          const upstreamRes = await fetch(upstream, {
            method: req.method,
            headers,
            body: body && body.length > 0 ? body : undefined,
          });

          res.statusCode = upstreamRes.status;
          upstreamRes.headers.forEach((value, key) => {
            const lower = key.toLowerCase();
            if (["transfer-encoding", "connection", "keep-alive", "content-encoding"].includes(lower)) return;
            res.setHeader(key, value);
          });

          const responseBody = await upstreamRes.arrayBuffer();
          res.end(Buffer.from(responseBody));
        } catch (err) {
          console.error("[api-proxy] error:", err);
          res.statusCode = 502;
          res.end(JSON.stringify({ message: "Proxy error" }));
        }
      });
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), tailwindcss(), apiProxyPlugin()],
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
      },
      dedupe: ["react", "react-dom"],
    },
  },
});
