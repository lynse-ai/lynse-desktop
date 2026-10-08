/** Shared fakes for BFF tests: an OpenConnector stub and a Lynse identity stub. */

import { createServer } from "node:http";

export function fakeGateway({ connections = [], onAuthorize, onAction, onDelete } = {}) {
  const seen = { authorizations: [], actions: [], tokenMints: [], deletes: [] };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const send = (status, payload) => {
      const data = JSON.stringify(payload ?? {});
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(data);
    };
    if (req.url === "/api/connections") {
      return send(200, connections);
    }
    if (req.url === "/api/runtime-tokens" && req.method === "POST") {
      seen.tokenMints.push(body);
      return send(200, { token: `oct-test-${seen.tokenMints.length}`, record: { id: `rt-${seen.tokenMints.length}`, ...body } });
    }
    if (req.url === "/api/oauth/authorizations" && req.method === "POST") {
      seen.authorizations.push(body);
      const custom = onAuthorize?.(body) ?? {};
      return send(200, {
        authorizationUrl: custom.authorizationUrl ?? `https://provider.example.com/authorize?state=${encodeURIComponent(body.connectionName ?? "x")}`,
        oauthAuthorizationId: custom.oauthAuthorizationId ?? `up-${body.connectionName ?? "x"}`,
        clientId: "gw-client",
        scope: "read",
        redirectUri: "https://www.lynse.ai/oc/oauth/callback",
      });
    }
    const actionMatch = req.url.match(/^\/v1\/actions\/(.+)$/);
    if (actionMatch && req.method === "POST") {
      const entry = { actionId: decodeURIComponent(actionMatch[1]), body, authorization: req.headers.authorization ?? "" };
      seen.actions.push(entry);
      const custom = onAction?.(entry);
      if (custom === undefined) return send(404, { error: "no such action" });
      if (custom?.error) return send(custom.status ?? 500, custom.body ?? {});
      return send(200, { output: custom });
    }
    const deleteMatch = req.url.match(/^\/api\/connections\/([^/]+)\/([^/]+)$/);
    if (deleteMatch && req.method === "DELETE") {
      seen.deletes.push({ service: decodeURIComponent(deleteMatch[1]), connectionId: decodeURIComponent(deleteMatch[2]) });
      onDelete?.(seen.deletes.at(-1));
      return send(200, { ok: true });
    }
    return send(404, { error: `unhandled ${req.method} ${req.url}` });
  });
  return { server, seen, connections };
}

export function fakeIdentity({ tokens }) {
  const hits = { count: 0 };
  const server = createServer((req, res) => {
    hits.count += 1;
    const auth = String(req.headers.authorization ?? "");
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    const user = tokens[token];
    if (!user) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "missing_token" } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ user_id: user }));
  });
  return { server, hits };
}

export function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

export function decodeJwtPayload(jwt) {
  const part = String(jwt ?? "").split(".")[1] ?? "";
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

export async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}
