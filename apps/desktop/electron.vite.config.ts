import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";
import http from "http";
import https from "https";
import { URL } from "url";

const DEFAULT_API_URL = "http://119.97.160.133:10060";

/**
 * Vite plugin that adds a server-side proxy for API requests.
 * Uses Node http module for reliable body forwarding.
 */
function apiProxyPlugin(): Plugin {
  return {
    name: "lynse-api-proxy",
    configureServer(server) {
      server.middlewares.use("/api/proxy", async (req, res, _next) => {
        try {
          const targetUrl = (req.headers["x-lynse-api-url"] as string) || DEFAULT_API_URL;
          const path = req.url || "/";
          const parsed = new URL(path, targetUrl);
          const isHttps = parsed.protocol === "https:";
          const transport = isHttps ? https : http;

          console.log(`[api-proxy] ${req.method} ${path} → ${parsed.protocol}//${parsed.hostname}:${parsed.port || (isHttps ? 443 : 80)}${parsed.pathname}${parsed.search}`);

          const fwdHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(req.headers)) {
            const lower = key.toLowerCase();
            if (["host", "x-lynse-api-url", "accept-encoding", "connection", "keep-alive", "transfer-encoding"].includes(lower)) continue;
            if (typeof value === "string") fwdHeaders[key] = value;
            else if (Array.isArray(value)) fwdHeaders[key] = value.join(", ");
          }
          // Set the correct Host header for the target
          fwdHeaders["host"] = parsed.host;
          console.log(`[api-proxy] X-API-Key: ${fwdHeaders['x-api-key'] || '(missing)'}, Authorization: ${fwdHeaders['authorization'] ? '***' : '(none)'}`);

          // Collect body
          let bodyChunks: Buffer[] = [];
          if (req.method !== "GET" && req.method !== "HEAD") {
            bodyChunks = await new Promise<Buffer[]>((resolve, reject) => {
              const chunks: Buffer[] = [];
              req.on("data", (chunk: Buffer) => chunks.push(chunk));
              req.on("end", () => resolve(chunks));
              req.on("error", reject);
            });
          }
          const bodyBuf = Buffer.concat(bodyChunks);
          if (bodyBuf.length > 0) {
            fwdHeaders["content-length"] = String(bodyBuf.length);
          }

          // Log request body for debugging
          if (bodyBuf.length > 0 && fwdHeaders['content-type']?.includes('json')) {
            console.log(`[api-proxy] Body: ${bodyBuf.toString('utf-8').slice(0, 500)}`);
          }

          const options: http.RequestOptions = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: req.method,
            headers: fwdHeaders,
            ...(isHttps ? { rejectUnauthorized: false } : {}),
          };

          const proxyReq = transport.request(options, (proxyRes) => {
            res.statusCode = proxyRes.statusCode || 502;
            for (const [key, value] of Object.entries(proxyRes.headers)) {
              if (!value) continue;
              const lower = key.toLowerCase();
              if (["transfer-encoding", "connection", "keep-alive"].includes(lower)) continue;
              res.setHeader(key, value);
            }

            // SSE / streaming: pipe chunks directly without buffering
            const contentType = (proxyRes.headers["content-type"] || "").toString().toLowerCase();
            const isStreaming = contentType.includes("text/event-stream") || contentType.includes("application/stream");

            if (isStreaming) {
              console.log(`[api-proxy] ${req.method} ${path} → SSE streaming`);
              proxyRes.on("data", (chunk) => res.write(chunk));
              proxyRes.on("end", () => {
                console.log(`[api-proxy] ${req.method} ${path} stream ended (status: ${res.statusCode})`);
                res.end();
              });
            } else {
              // Non-streaming: buffer for logging
              const chunks: Buffer[] = [];
              proxyRes.on("data", (chunk) => chunks.push(chunk));
              proxyRes.on("end", () => {
                const resBody = Buffer.concat(chunks);
                const statusNote = res.statusCode && res.statusCode >= 400 ? ` body: ${resBody.toString("utf-8").slice(0, 200)}` : "";
                console.log(`[api-proxy] ${req.method} ${path} status: ${res.statusCode} (${resBody.length} bytes)${statusNote}`);
                res.end(resBody);
              });
            }
          });

          proxyReq.on("error", (err) => {
            console.error("[api-proxy] http error:", err.message);
            res.statusCode = 502;
            res.end(JSON.stringify({ message: `Proxy error: ${err.message}` }));
          });

          if (bodyBuf.length > 0) {
            proxyReq.write(bodyBuf);
          }
          proxyReq.end();
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
