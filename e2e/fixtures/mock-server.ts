import http from "node:http";
import { randomUUID } from "node:crypto";
import { AddressInfo } from "node:net";
import { defaultJsonRoutes } from "./api-mocks";
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

/** How long a finished task stays readable before it "expires" (404). */
const TASK_TTL_MS = 15 * 60_000;

/**
 * Minimum wait before a scripted turn resolves, so tests can observe the
 * pending phase (Stop button, waiting indicator) before `done` lands.
 */
const MIN_TURN_DELAY_MS = 600;

export interface MockServer {
  url: string;
  port: number;
  /** Replace the active chat script (turn counter resets per sessionId). */
  setChatScript(script: ChatScript): void;
  /** Override/add a JSON route at runtime. */
  setJsonRoute(path: string, body: unknown): void;
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
  const jsonRoutes = new Map<string, unknown>(Object.entries(defaultJsonRoutes()));
  // sessionId → next turn index; each conversation replays turns in order.
  const turnCounters = new Map<string, number>();
  // task_id → submitted turn; the GET serves the result once it is due.
  const tasks = new Map<string, ChatTask>();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      const ctx = await readCtx(req, url);

      if (ctx.method === "POST" && path === CHAT_POLL_PATH) {
        handleChatSubmit(ctx, tasks, res, () => {
          const sessionId = String(ctx.body.sessionId ?? "default");
          const index = turnCounters.get(sessionId) ?? 0;
          turnCounters.set(sessionId, index + 1);
          return chatScript?.turns[Math.min(index, (chatScript.turns.length ?? 1) - 1)] ?? null;
        });
        return;
      }

      if (ctx.method === "GET" && path.startsWith(`${CHAT_POLL_PATH}/`)) {
        const taskId = decodeURIComponent(path.slice(CHAT_POLL_PATH.length + 1));
        handleChatPoll(taskId, tasks, res);
        return;
      }

      // JSON routes: exact match first, then prefix match (longest wins).
      let body = jsonRoutes.get(path);
      if (body === undefined) {
        const prefixes = [...jsonRoutes.keys()]
          .filter((k) => path.startsWith(k))
          .sort((a, b) => b.length - a.length);
        body = prefixes.length ? jsonRoutes.get(prefixes[0]!) : {};
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body ?? {}));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: String(err) }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    setChatScript(next) {
      chatScript = next;
      turnCounters.clear();
      tasks.clear();
    },
    setJsonRoute(path, body) {
      jsonRoutes.set(path, body);
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
function handleChatPoll(taskId: string, tasks: Map<string, ChatTask>, res: http.ServerResponse) {
  const task = tasks.get(taskId);
  if (!task || Date.now() - task.submittedAt > TASK_TTL_MS) {
    // Unknown id, process restart, or past TTL — the standard says 404.
    respondJson(res, 404, { detail: "任务不存在或已过期" });
    return;
  }

  const elapsed = Date.now() - task.submittedAt;
  if (elapsed < task.delayMs) {
    respondJson(res, 200, {
      task_id: taskId,
      status: "pending",
      text: null,
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

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
