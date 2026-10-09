import { callWorkBuddyOpenApi, workBuddySessionGuard } from "../auth/workbuddy";

export { hasWorkBuddyCloudScopes, WORKBUDDY_CLOUD_SCOPES } from "./scopes";

export interface WorkBuddyTask {
  task_id: string;
  status: string;
  name?: string;
  link?: string;
  token?: string;
  expire_at?: number;
  sandboxLink?: string;
  sandboxDataLink?: string;
}

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function unwrapWorkBuddy(value: unknown): Record<string, unknown> {
  const root = object(value);
  if (typeof root.code === "number" && root.code !== 0) {
    throw new Error(typeof root.msg === "string" ? root.msg : "WorkBuddy request failed");
  }
  return root.data && typeof root.data === "object" ? object(root.data) : root;
}

function task(value: unknown): WorkBuddyTask {
  const data = unwrapWorkBuddy(value);
  if (typeof data.task_id !== "string" || !data.task_id) throw new Error("Invalid WorkBuddy task");
  return {
    task_id: data.task_id,
    status: typeof data.status === "string" ? data.status : "CREATING",
    ...Object.fromEntries(["name", "link", "token", "sandboxLink", "sandboxDataLink"]
      .filter((key) => typeof data[key] === "string")
      .map((key) => [key, data[key]])),
    expire_at: typeof data.expire_at === "number" ? data.expire_at : undefined,
  };
}

/** The documented initial prompt sets up the task; ACP submits the turn. */
export async function createWorkBuddyTask(prompt: string): Promise<WorkBuddyTask> {
  return task(await callWorkBuddyOpenApi("/tasks", { method: "POST", body: { prompt } }));
}

export async function getWorkBuddyTask(taskId: string): Promise<WorkBuddyTask> {
  return task(await callWorkBuddyOpenApi(`/tasks/${encodeURIComponent(taskId)}`));
}

export interface WorkBuddyResourceResponse {
  status: number;
  body?: string;
  bytes?: number[];
  mimeType?: string;
}

type ResourceRelay = (request: { url: string; token: string; binary: boolean }) => Promise<WorkBuddyResourceResponse>;
let resourceRelay: ResourceRelay | null = null;

export function setWorkBuddyResourceRelay(relay: ResourceRelay | null): void {
  resourceRelay = relay;
}

/** Gateway links and sandbox links are distinct; never truncate /sessions/id. */
export function workBuddySandboxUrl(taskInfo: WorkBuddyTask): string | null {
  const explicit = taskInfo.sandboxDataLink || taskInfo.sandboxLink;
  if (explicit) return explicit.replace(/\/+$/, "");
  if (taskInfo.link && /\/acp\/?$/.test(taskInfo.link)) {
    return taskInfo.link.replace(/\/acp\/?$/, "");
  }
  return null;
}

async function readResource(taskInfo: WorkBuddyTask, path: string, binary: boolean): Promise<WorkBuddyResourceResponse> {
  const assertSession = workBuddySessionGuard();
  const base = workBuddySandboxUrl(taskInfo);
  if (!base || !taskInfo.token) throw new Error("WorkBuddy artifact address unavailable");
  if (!resourceRelay) throw new Error("WorkBuddy desktop bridge unavailable");
  const url = `${base}/${path.replace(/^\/+/, "")}`;
  let response = await resourceRelay({ url, token: taskInfo.token, binary });
  assertSession();
  if (response.status === 401) {
    const fresh = await getWorkBuddyTask(taskInfo.task_id);
    const freshBase = workBuddySandboxUrl(fresh);
    if (!freshBase || !fresh.token) throw new Error("WorkBuddy artifact address unavailable");
    response = await resourceRelay({
      url: `${freshBase}/${path.replace(/^\/+/, "")}`, token: fresh.token, binary,
    });
    assertSession();
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`WorkBuddy artifact request failed (${response.status})`);
  }
  return response;
}

export async function listWorkBuddyArtifacts(taskInfo: WorkBuddyTask): Promise<unknown[]> {
  const response = await readResource(taskInfo, `api/session/artifacts?sessionId=${encodeURIComponent(taskInfo.task_id)}`, false);
  const data = unwrapWorkBuddy(JSON.parse(response.body ?? "{}"));
  return Array.isArray(data.artifacts) ? data.artifacts : [];
}

export async function fetchWorkBuddyArtifact(taskId: string, uri: string): Promise<WorkBuddyResourceResponse> {
  if (!uri.startsWith("agent:///")) throw new Error("Unsupported WorkBuddy artifact URI");
  const path = uri.slice("agent:///".length);
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { throw new Error("Invalid WorkBuddy artifact URI"); }
  if (!path || decoded.split("/").some((part) => part === "..") || /[?#\\]/.test(decoded)) {
    throw new Error("Invalid WorkBuddy artifact URI");
  }
  return readResource(await getWorkBuddyTask(taskId), path, true);
}
