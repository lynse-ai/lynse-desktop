import http from "node:http";
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { defaultJsonRoutes } from "./api-mocks";
import {
  createIntegrationsState,
  handleIntegrationsRequest,
  type IntegrationsMockState,
} from "./integrations-mock";
import type { ChatScript, HttpErrorResponse, ScriptResponse } from "./chat-script";

/**
 * A local Lynse backend mock. The web app's real Next.js /api/proxy route
 * forwards every request to whatever URL is stored in localStorage
 * `lynse_api_url` — the fixtures point that at this server, so JSON APIs and
 * the poll chat endpoint both get real network semantics (in-flight tasks,
 * client aborts, 404s, etc.).
 *
 * Chat follows the lynclaw poll standard: `POST /api/chat/poll` submits a
 * turn and returns a `task_id` immediately; `GET /api/chat/poll/{task_id}`
 * answers `pending` until the scripted response is due, then returns the
 * complete result (`status: "done"` / `"error"`). A finished result keeps
 * being served for the task's TTL, like the real service.
 */

const CHAT_POLL_PATH = "/api/business/ai/chat/poll";

/** A 1×1 transparent PNG — enough for the chat <img> card to really load. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** A minimal one-page PDF (structure over content — the iframe just needs to resolve). */
const MINIMAL_PDF = [
  "%PDF-1.4",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj",
  "trailer<</Size 4/Root 1 0 R>>",
  "%%EOF",
].join("\n");

/** Static bytes the attachment scripts reference via `{{mock}}/mock-assets/*`. */
const MOCK_ASSETS: Record<string, { body: Buffer; contentType: string }> = {
  "/mock-assets/visual-summary.png": {
    body: Buffer.from(TINY_PNG_BASE64, "base64"),
    contentType: "image/png",
  },
  "/mock-assets/weekly-report.pdf": {
    body: Buffer.from(MINIMAL_PDF, "utf8"),
    contentType: "application/pdf",
  },
};

/** How long a finished task stays readable before it "expires" (404). */
const TASK_TTL_MS = 15 * 60_000;

/**
 * Minimum wait before a scripted turn resolves, so tests can observe the
 * pending phase (Stop button, waiting indicator) before `done` lands.
 */
const MIN_TURN_DELAY_MS = 600;

/**
 * A route value is either a bare body (answered 200 as-is, the legacy shape)
 * or a descriptor that can also control the status code, the `{code,data}`
 * gateway envelope, and a delay. The envelope matters because the real gateway
 * wraps payloads (`client.ts` unwraps them), and a mock that always returns a
 * bare body hides that difference until the switch to the real backend.
 */
export interface MockRouteDescriptor {
  status?: number;
  body?: unknown;
  /** Wrap the body as `{ code, data, msg }` like the production gateway. */
  envelope?: boolean;
  /** Business code inside the envelope; non-200 here is a thrown ApiError. */
  code?: number;
  msg?: string;
  delayMs?: number;
}

export type MockRoute = unknown | MockRouteDescriptor;

/** One recorded request, for assertions the response alone cannot make. */
export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

function isRouteDescriptor(value: unknown): value is MockRouteDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    ("status" in value || "envelope" in value || "body" in value || "delayMs" in value || "code" in value)
  );
}

export interface MockServer {
  url: string;
  port: number;
  /** Mutable state behind the `/api/v2/integrations` + `/api/v2/calendar` routes. */
  integrations: IntegrationsMockState;
  /** Replace the active chat script (turn counter resets per sessionId). */
  setChatScript(script: ChatScript): void;
  /** Override/add a JSON route at runtime (path only; any method). */
  setJsonRoute(path: string, body: unknown): void;
  /**
   * Add/override a route with method awareness. Key is `"/path"` (any method)
   * or `"POST /path"`; a `"*"` method wildcard is accepted too. Prefix routes
   * end with `/`.
   */
  setRoute(key: string, route: MockRoute): void;
  /** Every request the server has answered, in arrival order. */
  requests(filter?: Partial<Pick<RecordedRequest, "method" | "path">>): RecordedRequest[];
  /** The newest matching request, or undefined. */
  lastRequest(filter?: Partial<Pick<RecordedRequest, "method" | "path">>): RecordedRequest | undefined;
  clearRequests(): void;
  close(): Promise<void>;
}

interface RequestCtx {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

/** Scripted responses that become tasks — `http-error` fails at submit instead. */
type TaskResponse = Exclude<ScriptResponse, HttpErrorResponse>;

interface ChatTask {
  response: TaskResponse;
  /** Elapsed time from submit until the task leaves `pending`. */
  delayMs: number;
  submittedAt: number;
}

export async function startMockServer(script?: ChatScript): Promise<MockServer> {
  let chatScript = script;
  /** Keys are `"METHOD /path"`, or `"* /path"` for the legacy path-only form. */
  const jsonRoutes = new Map<string, MockRoute>(
    Object.entries(defaultJsonRoutes()).map(([path, body]) => [`* ${path}`, body as MockRoute]),
  );
  const integrations = createIntegrationsState();
  const recorded: RecordedRequest[] = [];
  // sessionId → next turn index; each conversation replays turns in order.
  const turnCounters = new Map<string, number>();
  // task_id → submitted turn; the GET serves the result once it is due.
  const tasks = new Map<string, ChatTask>();
  // Lazy-signed artifacts (mint_url fixtures): artifact_id → URL minted on refresh.
  const mintUrls = new Map<string, string>();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      const ctx = await readCtx(req, url);

      // The desktop-renderer E2E hits this server directly from a plain
      // (CORS-enforcing) browser, so every answer must be cross-origin.
      // The API client sends credentials, so the origin must be echoed back
      // exactly — `*` is rejected by the browser for credentialed requests.
      res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-lynse-api-url, x-api-key, x-client-platform");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      if (ctx.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      recorded.push({
        method: ctx.method,
        path,
        query: Object.fromEntries(url.searchParams.entries()),
        body: ctx.body,
        headers: req.headers,
      });

      // The Connections contract is stateful (accounts, toggles, exports,
      // injected failures), so it is served by its own handler instead of the
      // flat route table below.
      if (
        handleIntegrationsRequest(
          { method: ctx.method, path, query: url.searchParams, body: ctx.body },
          res,
          integrations,
        )
      ) {
        return;
      }

      // Real bytes for the attachment scripts (`{{mock}}/mock-assets/*`).
      const asset = MOCK_ASSETS[path];
      if (asset) {
        res.writeHead(200, { "Content-Type": asset.contentType });
        res.end(asset.body);
        return;
      }

      const route = matchRoute(jsonRoutes, ctx.method, path);
      if (route === undefined && ctx.method === "POST" && path === "/api/session/backend") {
        respondJson(res, 200, { host: ctx.body.host, user_id: "user-e2e" });
        return;
      }
      const pollPath = path.startsWith("/api/chat/") ? "/api/chat/poll" : CHAT_POLL_PATH;
      // Exercise SSE fallback against a backend that explicitly lacks streaming.
      if (route === undefined && ctx.method === "POST" &&
          (path === "/api/chat/stream" || path === "/api/business/ai/chat/stream")) {
        respondJson(res, 404, { detail: "Streaming is unavailable on the scripted backend" });
        return;
      }

      if (route === undefined && ctx.method === "POST" && path === pollPath) {
        handleChatSubmit(ctx, tasks, res, () => {
          const sessionId = String(ctx.body.sessionId ?? "default");
          const index = turnCounters.get(sessionId) ?? 0;
          turnCounters.set(sessionId, index + 1);
          return chatScript?.turns[Math.min(index, (chatScript.turns.length ?? 1) - 1)] ?? null;
        });
        return;
      }

      if (route === undefined && ctx.method === "GET" && path.startsWith(`${pollPath}/`)) {
        const taskId = decodeURIComponent(path.slice(pollPath.length + 1));
        handleChatPoll(taskId, tasks, origin, res, mintUrls);
        return;
      }

      // Attachment URL minting (the lazy-sign contract's refresh endpoint):
      // a 32-hex artifact id registered by a mint_url fixture answers with a
      // fresh signed URL; unknown ids answer empty, like a failed re-sign.
      const mintMatch =
        ctx.method === "POST" && path.match(/^\/api\/attachments\/([0-9a-fA-F]{32})\/download-url$/);
      if (mintMatch) {
        const mintUrl = mintUrls.get(mintMatch[1]!);
        respondJson(res, 200, mintUrl ? { download_url: mintUrl } : {});
        return;
      }

      // JSON routes: method-qualified keys win over path-only keys, exact
      // beats prefix, longest prefix wins.
      if (route === undefined) {
        respondJson(res, 200, {});
        return;
      }
      const descriptor: MockRouteDescriptor = isRouteDescriptor(route) ? route : { body: route };
      if (descriptor.delayMs) await sleep(descriptor.delayMs);
      if (descriptor.status && descriptor.status !== 200) {
        respondJson(res, descriptor.status, descriptor.body ?? { message: `mock ${descriptor.status}` });
        return;
      }
      if (descriptor.envelope) {
        // Production gateway shape: HTTP 200 with a business code inside.
        respondJson(res, 200, {
          code: descriptor.code ?? 200,
          data: descriptor.body ?? {},
          msg: descriptor.msg ?? "ok",
        });
        return;
      }
      respondJson(res, 200, descriptor.body ?? {});
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: String(err) }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // Attachment scripts write `{{mock}}` in their URLs; rewrite it to this
  // run's origin so the browser can actually fetch the scripted assets.
  const origin = `http://127.0.0.1:${port}`;

  return {
    url: origin,
    port,
    integrations,
    setChatScript(next) {
      chatScript = next;
      turnCounters.clear();
      tasks.clear();
      mintUrls.clear();
    },
    setJsonRoute(path, body) {
      jsonRoutes.set(normalizeRouteKey(path), body as MockRoute);
    },
    setRoute(key, route) {
      jsonRoutes.set(normalizeRouteKey(key), route);
    },
    requests(filter) {
      if (!filter) return [...recorded];
      return recorded.filter(
        (r) =>
          (!filter.method || r.method === filter.method.toUpperCase()) &&
          (!filter.path || r.path === filter.path),
      );
    },
    lastRequest(filter) {
      const matches = recorded.filter(
        (r) =>
          (!filter?.method || r.method === filter.method.toUpperCase()) &&
          (!filter?.path || r.path === filter.path),
      );
      return matches[matches.length - 1];
    },
    clearRequests() {
      recorded.length = 0;
    },
    close() {
      return new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

function readCtx(req: http.IncomingMessage, url: URL): Promise<RequestCtx> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      resolve({
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        body,
        headers: req.headers,
      });
    });
    req.on("error", reject);
  });
}

/** How long the scripted response stays `pending` after submit. */
function turnDelayMs(r: TaskResponse): number {
  if (r.type === "stream") {
    return Math.max(MIN_TURN_DELAY_MS, r.chunks.length * (r.chunkDelayMs ?? 60));
  }
  if (r.type === "stream-abort") {
    // Never resolves while the test is watching — the client must hit Stop.
    return r.holdOpenMs ?? 120_000;
  }
  return MIN_TURN_DELAY_MS;
}

/** Submit a turn: register the scripted response as a task, hand out an id. */
function handleChatSubmit(
  ctx: RequestCtx,
  tasks: Map<string, ChatTask>,
  res: http.ServerResponse,
  nextTurn: () => { user: string; response: ScriptResponse } | null,
) {
  const turn = nextTurn();

  if (turn?.response.type === "http-error") {
    // Fails at the HTTP level on submit — no task is ever created.
    respondJson(res, turn.response.status, { detail: turn.response.message });
    return;
  }

  const taskId = newTaskId();
  tasks.set(taskId, {
    response: turn?.response ?? { type: "stream", chunks: [""] },
    delayMs: turn ? turnDelayMs(turn.response) : 0,
    submittedAt: Date.now(),
  });
  if (process.env.MOCK_VERBOSE) {
    console.log(`[mock-poll] task ${taskId} created (${turn?.response.type ?? "bare"})`);
  }
  respondJson(res, 200, {
    task_id: taskId,
    status: "pending",
    session_id: String(ctx.body.sessionId ?? "default"),
    user_id: String(ctx.body.user_id ?? "user"),
  });
}

/** Query a task: `pending` until due, then the complete scripted result. */
function handleChatPoll(
  taskId: string,
  tasks: Map<string, ChatTask>,
  origin: string,
  res: http.ServerResponse,
  mintUrls: Map<string, string>,
) {
  const task = tasks.get(taskId);
  if (!task || Date.now() - task.submittedAt > TASK_TTL_MS) {
    // Unknown id, process restart, or past TTL — the standard says 404.
    respondJson(res, 404, { detail: "任务不存在或已过期" });
    return;
  }

  const elapsed = Date.now() - task.submittedAt;
  if (elapsed < task.delayMs) {
    // Mimic the real service's live partial text: `stream` turns reveal
    // their chunks on the scripted cadence while pending, so the client's
    // progressive-text path gets exercised end to end. `stream-abort` stays
    // text-free on purpose — the Stop-button spec depends on a pending turn
    // with nothing renderable yet.
    let partialText: string | null = null;
    if (task.response.type === "stream" && task.response.chunks.length) {
      const cadence = task.response.chunkDelayMs ?? 60;
      const revealed = Math.min(
        task.response.chunks.length,
        Math.floor(elapsed / cadence),
      );
      partialText = task.response.chunks.slice(0, revealed).join("") || null;
    }
    respondJson(res, 200, {
      task_id: taskId,
      status: "pending",
      text: partialText,
      sources: [],
      attachments: [],
      human_support_link: null,
      confirmation: null,
      error: null,
    });
    return;
  }

  const r = task.response;
  switch (r.type) {
    case "clarify": {
      // Cloud-shaped confirmation card; the client echoes `confirmToken`
      // back on the follow-up submit.
      respondJson(res, 200, {
        task_id: taskId,
        status: "done",
        text: "",
        sources: [],
        attachments: [],
        human_support_link: null,
        confirmation: {
          type: "confirmation",
          kind: "clarify",
          title: r.question,
          confirmToken: `mock-token-${taskId.slice(0, 8)}`,
          riskLevel: "low",
          actions: r.options,
        },
        error: null,
      });
      break;
    }
    case "error": {
      // Business failure is a 200 with `status: "error"`, not a 5xx.
      respondJson(res, 200, {
        task_id: taskId,
        status: "error",
        text: null,
        sources: [],
        attachments: [],
        human_support_link: null,
        confirmation: null,
        error: r.message,
      });
      break;
    }
    case "attachments": {
      // Visual-summary / report-PDF turns: the body plus lynclaw-shaped
      // attachment entries whose `{{mock}}` URLs point at this server.
      // Entries carrying `mint_url` exercise the CloudBase storage backend's
      // lazy-signing contract: the payload ships `download_url: ""` and the
      // client must mint the URL via POST /api/attachments/{id}/download-url.
      respondJson(res, 200, {
        task_id: taskId,
        status: "done",
        text: r.text,
        sources: (r.sources ?? []).map((s) => s.title),
        attachments: r.attachments.map((a) => {
          if (a.mint_url) {
            const artifactId = String(a.artifact_id ?? "");
            if (artifactId) mintUrls.set(artifactId, a.mint_url.replace("{{mock}}", origin));
            const { mint_url: _mint, ...entry } = a;
            return { ...entry, download_url: "" };
          }
          return { ...a, download_url: a.download_url.replace("{{mock}}", origin) };
        }),
        human_support_link: null,
        confirmation: null,
        error: null,
      });
      break;
    }
    default: {
      // `stream` and the tail of `stream-abort` both finish as a full answer.
      respondJson(res, 200, {
        task_id: taskId,
        status: "done",
        text: r.chunks.join(""),
        sources: r.type === "stream" ? (r.sources ?? []).map((s) => s.title) : [],
        attachments: [],
        human_support_link: null,
        confirmation: null,
        error: null,
      });
    }
  }
}

const newTaskId = () => randomUUID().replace(/-/g, "");

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `"POST /api/x"` → `"POST /api/x"`; `"/api/x"` → `"* /api/x"` so the legacy
 * path-only fixtures keep answering every verb, exactly as before.
 */
function normalizeRouteKey(key: string): string {
  const trimmed = key.trim();
  const match = trimmed.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/.*)$/i);
  return match ? `${match[1]!.toUpperCase()} ${match[2]}` : `* ${trimmed}`;
}

/** Method-qualified exact match beats wildcard; exact beats prefix; longest prefix wins. */
function matchRoute(routes: Map<string, MockRoute>, method: string, path: string): MockRoute | undefined {
  for (const key of [`${method} ${path}`, `* ${path}`]) {
    const value = routes.get(key);
    if (value !== undefined) return value;
  }
  const split = (key: string): { verb: string; prefix: string } => {
    const space = key.indexOf(" ");
    return { verb: key.slice(0, space), prefix: key.slice(space + 1) };
  };
  const candidates = [...routes.keys()]
    .map(split)
    .filter(({ verb }) => verb === method || verb === "*")
    .filter(({ prefix }) => path.startsWith(prefix))
    .sort((a, b) => {
      if (b.prefix.length !== a.prefix.length) return b.prefix.length - a.prefix.length;
      const rank = (verb: string) => (verb === method ? 0 : 1);
      return rank(a.verb) - rank(b.verb);
    });
  const first = candidates[0];
  return first ? routes.get(`${first.verb} ${first.prefix}`) : undefined;
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
