import i18next from "i18next";
import { getWorkBuddyToken, WORKBUDDY_ERROR, WorkBuddyRateLimitError } from "@lynse/core/auth/workbuddy";
import {
  createWorkBuddyTask, getWorkBuddyTask, hasWorkBuddyAcpBridge, hasWorkBuddyCloudScopes, listWorkBuddyArtifacts,
  object, WorkBuddyAcpClient, WorkBuddyAcpHttpError,
  type RpcId, type RpcMessage, type WorkBuddyTask,
} from "@lynse/core/workbuddy";
import type { ChatAttachment, ChatConfirm } from "./types";
import type { ChatTransport, SendChatOptions } from "./chat-transport";

function wt(key: string, fallback: string): string {
  return i18next.isInitialized ? i18next.t(key) : fallback;
}

export const workbuddyCloudTiming = { taskReadyMs: 60_000, taskPollMs: 1_000, handshakeMs: 30_000, turnMs: 15 * 60_000 };
export { hasWorkBuddyCloudScopes, WORKBUDDY_CLOUD_SCOPES } from "@lynse/core/workbuddy";

function options(value: unknown): { label: string; value: string }[] {
  return (Array.isArray(value) ? value : []).flatMap((entry) => {
    if (typeof entry === "string") return [{ label: entry, value: entry }];
    const data = object(entry);
    const label = data.name ?? data.label ?? data.title;
    const id = data.optionId ?? data.value ?? label;
    return typeof label === "string" && typeof id === "string" ? [{ label, value: id }] : [];
  });
}

/** WorkBuddy AskQuestion payloads are carried with the permission request. */
export function workBuddyPermission(message: RpcMessage): ChatConfirm | null {
  if (message.id === undefined) return null;
  const params = object(message.params);
  const tool = object(params.toolCall);
  let input = object(tool.rawInput);
  if (typeof tool.rawInput === "string") {
    try { input = object(JSON.parse(tool.rawInput)); } catch { /* Plain tool input is not a questionnaire. */ }
  }
  const rawQuestions = params.questions ?? input.questions ?? object(params._meta).questions;
  const questions = (Array.isArray(rawQuestions) ? rawQuestions : []).flatMap((value, index) => {
    const question = object(value);
    const text = question.question ?? question.header ?? question.title;
    if (typeof text !== "string") return [];
    return [{
      id: typeof question.id === "string" ? question.id : `q_${index}`,
      question: text, multiSelect: question.multiSelect === true || question.multiple === true,
      options: options(question.options),
    }];
  });
  const choices = options(params.options);
  const question = params.title ?? tool.title ?? params.question;
  if (!choices.length && !questions.length) return null;
  return {
    question: typeof question === "string" ? question : wt("workbuddy.cloud_confirm", "WorkBuddy 需要你的确认"),
    options: choices,
    kind: "workbuddy_acp",
    preview: tool.rawInput !== undefined ? {
      [wt("workbuddy.cloud_details", "操作详情")]: typeof tool.rawInput === "string" ? tool.rawInput : JSON.stringify(tool.rawInput, null, 2),
    } : undefined,
    workbuddy: { requestId: message.id, questions: questions.length ? questions : undefined },
  };
}

export function workBuddyArtifact(raw: unknown, taskId: string): ChatAttachment | null {
  const entry = object(raw);
  const artifact = object(entry.artifact ?? raw);
  const uri = artifact.uri;
  if (typeof uri !== "string" || !uri) return null;
  const type = artifact.type;
  if (!["media", "plan", "tasks", "overview"].includes(String(type))) return null;
  let text = typeof artifact.text === "string" ? artifact.text : undefined;
  if (type === "tasks" && Array.isArray(artifact.tasks)) {
    text = artifact.tasks.map((value) => {
      const task = object(value);
      return `- [${task.status === "completed" ? "x" : " "}] ${typeof task.content === "string" ? task.content : ""}`;
    }).join("\n");
  }
  const rawUrl = entry.url ?? artifact.url;
  const url = typeof rawUrl === "string" && /^https:\/\//.test(rawUrl) ? rawUrl : undefined;
  const name = artifact.name ?? artifact.title ?? uri.split("/").at(-1);
  return {
    id: `workbuddy:${taskId}:${uri}`,
    name: typeof name === "string" ? name : "WorkBuddy",
    type: type === "media" ? String(artifact.mimeType ?? "file") : "markdown",
    url, downloadUrl: url, text,
    workbuddyArtifact: uri.startsWith("agent:///") ? {
      taskId, uri, revision: typeof entry.md5 === "string" ? entry.md5
        : typeof artifact.updatedAt === "number" ? String(artifact.updatedAt) : undefined,
    } : undefined,
  };
}

interface Permission { confirm: ChatConfirm; answering: boolean }
export interface WorkBuddyHistoryEntry { role: "user" | "assistant"; content: string; serverId?: string }
export interface WorkBuddyCloudHistory { messages: WorkBuddyHistoryEntry[]; attachments: ChatAttachment[] }

export class WorkBuddyCloudChatTransport implements ChatTransport {
  readonly provider = "workbuddy" as const;
  private cancelled = false;
  private rpc: WorkBuddyAcpClient | null = null;
  private opts: SendChatOptions | null = null;
  private taskInfo: WorkBuddyTask | null = null;
  private phase: "loading" | "prompting" | "done" = "loading";
  private text = "";
  private artifacts = new Map<string, ChatAttachment>();
  private artifactVersions = new Map<string, number>();
  private artifactRevision = 0;
  private permissions = new Map<RpcId, Permission>();
  private cancellation: Promise<void> | null = null;
  private replay: WorkBuddyHistoryEntry[] = [];

  /** Restore an idle task without submitting a prompt or approving a tool. */
  async loadHistory(taskId: string, signal?: AbortSignal): Promise<WorkBuddyCloudHistory> {
    const abort = () => this.cancel();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw new Error("cancelled");
      const grant = await getWorkBuddyToken();
      if (!grant.authorized || grant.expired) throw new Error(WORKBUDDY_ERROR.NOT_BOUND);
      if (!hasWorkBuddyCloudScopes(grant.scope)) throw new Error("WorkBuddy cloud scope required");
      const task = await getWorkBuddyTask(taskId);
      if (!task.link || !task.token || this.cancelled) throw new Error("WorkBuddy task unavailable");
      this.taskInfo = task;
      await this.connect(task);
      this.phase = "done";
      await this.restoreArtifacts();
      if (this.cancelled) throw new Error("cancelled");
      return { messages: this.replay, attachments: [...this.artifacts.values()] };
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.cancellation) await this.cancellation;
      else await this.rpc?.close().catch(() => undefined);
    }
  }

  private emit(event: Parameters<SendChatOptions["onEvent"]>[0]): void {
    if (!this.cancelled && !this.opts?.signal?.aborted) this.opts?.onEvent(event);
  }

  async send(opts: SendChatOptions): Promise<void> {
    this.opts = opts;
    const abort = () => this.cancel();
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) { this.cancelled = true; return; }
    try {
      if (!hasWorkBuddyAcpBridge()) throw new Error(wt("workbuddy.cloud_desktop_only", "WorkBuddy 云端对话需要桌面应用"));
      const grant = await getWorkBuddyToken();
      if (!grant.authorized || grant.expired) throw new Error(WORKBUDDY_ERROR.NOT_BOUND);
      if (!hasWorkBuddyCloudScopes(grant.scope)) {
        this.emit({ type: "error", workbuddyAuthRequired: true,
          message: wt("workbuddy.cloud_scope_required", "请重新授权 WorkBuddy，允许读取和执行云端任务") });
        return;
      }
      if (this.cancelled) return;
      this.emit({ type: "status", text: wt("workbuddy.cloud_connecting", "正在连接 WorkBuddy 云端…") });
      let task = opts.workbuddySession?.taskId
        ? await getWorkBuddyTask(opts.workbuddySession.taskId) : await createWorkBuddyTask(opts.query);
      // Save immediately, even when sandbox startup takes longer or fails.
      this.emit({ type: "workbuddy_session", session: { mode: "cloud", taskId: task.task_id } });
      const deadline = Date.now() + workbuddyCloudTiming.taskReadyMs;
      while (!task.link || !task.token) {
        if (this.cancelled) return;
        if (["failed", "deleted", "archived"].includes(task.status.toLowerCase())) throw new Error(wt("workbuddy.cloud_task_unavailable", "WorkBuddy 云端任务不可用，请新建会话"));
        if (Date.now() >= deadline) throw new Error(wt("workbuddy.cloud_task_timeout", "WorkBuddy 云端任务启动超时，可在此会话中重试连接"));
        await new Promise((resolve) => setTimeout(resolve, workbuddyCloudTiming.taskPollMs));
        if (this.cancelled) return;
        task = await getWorkBuddyTask(task.task_id);
      }
      this.taskInfo = task;
      if (this.cancelled) return;
      await this.connect(task);
      if (this.cancelled) return;
      // Artifact restoration is best-effort; unavailable media must not block chat.
      void this.restoreArtifacts();
      if (this.cancelled) return;
      this.phase = "prompting";
      this.emit({ type: "status", text: "thinking" });
      // Follow the documented v1 flow. Never replay a submitted prompt on a
      // network/401 failure: its execution result may already be in flight.
      const result = object(await this.rpc!.request("session/prompt", {
        sessionId: task.task_id, prompt: [{ type: "text", text: opts.query }],
      }, workbuddyCloudTiming.turnMs));
      if (this.cancelled) return;
      const reason = result.stopReason;
      if (typeof reason !== "string") throw new Error("WorkBuddy prompt response missing stopReason");
      this.phase = "done";
      this.clearPermissions();
      if (reason === "end_turn" && !this.text && !this.artifacts.size) {
        // Give the artifact-only completion a chance to restore its cards.
        await this.restoreArtifacts();
        if (!this.artifacts.size) throw new Error(wt("workbuddy.chat_empty_reply", "WorkBuddy 没有返回内容，请稍后重试"));
      }
      void this.restoreArtifacts();
      this.emit({ type: "done", text: this.text, sources: [], attachments: [...this.artifacts.values()], workbuddyStopReason: reason });
    } catch (error) {
      if (!this.cancelled) {
        const message = error instanceof Error ? error.message : String(error);
        const missingScope = message.includes("insufficient_scope");
        const auth = message === WORKBUDDY_ERROR.NOT_BOUND || message === WORKBUDDY_ERROR.TOKEN_EXPIRED || missingScope;
        this.emit({ type: "error", workbuddyAuthRequired: auth, message: auth
          ? missingScope ? wt("workbuddy.cloud_scope_required", "请重新授权 WorkBuddy，允许读取和执行云端任务") : wt("workbuddy.chat_not_authorized", "WorkBuddy 尚未授权，请先完成授权")
          : error instanceof WorkBuddyRateLimitError ? wt("workbuddy.chat_rate_limited", "WorkBuddy 请求过于频繁，请稍后再试")
          : error instanceof WorkBuddyAcpHttpError && error.status === 401
            ? wt("workbuddy.cloud_interrupted", "WorkBuddy 连接已失效，请重新连接；已提交的消息不会自动重发")
            : wt("workbuddy.cloud_failed", "WorkBuddy 云端连接失败，请稍后重试") + ` (${message})` });
      }
    } finally {
      this.clearPermissions();
      opts.signal?.removeEventListener("abort", abort);
      if (this.cancellation) await this.cancellation;
      else await this.rpc?.close().catch(() => undefined);
    }
  }

  private async connect(task: WorkBuddyTask): Promise<void> {
    // Ticket renewal is safe before prompt submission, including load/initialize.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.replay = [];
      this.rpc = new WorkBuddyAcpClient((message) => this.notification(message), (message) => this.request(message));
      try {
        await this.rpc.connect(task.link!, task.token!);
        if (this.cancelled) { await this.rpc.close(); return; }
        const initialized = object(await this.rpc.request("initialize", {
          protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        }, workbuddyCloudTiming.handshakeMs));
        if (initialized.protocolVersion !== undefined && initialized.protocolVersion !== 1) throw new Error("Unsupported WorkBuddy ACP protocol version");
        await this.rpc.request("session/load", { sessionId: task.task_id, cwd: "/workspace", mcpServers: [] }, workbuddyCloudTiming.turnMs);
        return;
      } catch (error) {
        await this.rpc.close().catch(() => undefined);
        if (this.cancelled || attempt > 0 || !(error instanceof WorkBuddyAcpHttpError) || error.status !== 401) throw error;
        task = await getWorkBuddyTask(task.task_id);
        if (!task.link || !task.token) throw error;
        this.taskInfo = task;
      }
    }
  }

  private notification(message: RpcMessage): void {
    const params = object(message.params);
    if (params.sessionId !== this.taskInfo?.task_id) return;
    if (message.method === "_codebuddy.ai/artifact") {
      const attachment = workBuddyArtifact(params, this.taskInfo!.task_id);
      if (!attachment) return;
      this.artifactVersions.set(attachment.id!, ++this.artifactRevision);
      if (params.event === "deleted") this.artifacts.delete(attachment.id!);
      else this.artifacts.set(attachment.id!, attachment);
      this.emit({ type: "meta", sources: [], attachments: [...this.artifacts.values()] });
      return;
    }
    if (message.method !== "session/update") return;
    const update = object(params.update);
    const content = object(update.content);
    // Replay belongs to history, never the bubble for the newly submitted turn.
    if (this.phase === "loading") {
      const role = update.sessionUpdate === "user_message_chunk" ? "user"
        : update.sessionUpdate === "agent_message_chunk" ? "assistant" : null;
      if (role && content.type === "text" && typeof content.text === "string") {
        const serverId = typeof update.messageId === "string" ? update.messageId : undefined;
        const previous = this.replay.at(-1);
        if (previous?.role === role && previous.serverId === serverId) previous.content += content.text;
        else this.replay.push({ role, content: content.text, serverId });
      }
      return;
    }
    if (this.phase !== "prompting") return;
    if (update.sessionUpdate === "agent_message_chunk" && content.type === "text" && typeof content.text === "string") {
      this.text += content.text;
      this.emit({ type: "content", delta: content.text });
    } else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      const id = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
      const name = typeof update.title === "string" ? update.title : wt("workbuddy.cloud_tool", "WorkBuddy 正在执行工具");
      this.emit({ type: "tool", id, name, state: ["completed", "failed"].includes(String(update.status)) ? "done" : "running" });
    } else if (update.sessionUpdate === "plan" && Array.isArray(update.entries)) {
      const text = update.entries.map((value) => { const entry = object(value); return `- [${entry.status === "completed" ? "x" : " "}] ${String(entry.content ?? "")}`; }).join("\n");
      const id = `workbuddy:${this.taskInfo!.task_id}:plan`;
      this.artifacts.set(id, { id, name: wt("workbuddy.cloud_plan", "执行计划"), type: "markdown", text });
      this.emit({ type: "meta", sources: [], attachments: [...this.artifacts.values()] });
    }
  }

  private request(message: RpcMessage): void {
    if (message.id === undefined) return;
    const params = object(message.params);
    if (message.method !== "session/request_permission" || params.sessionId !== this.taskInfo?.task_id) {
      void this.rpc?.rejectRequest(message.id).catch(() => undefined);
      return;
    }
    if (this.phase !== "prompting") {
      void this.rpc?.respond(message.id, { outcome: { outcome: "cancelled" } }).catch(() => undefined);
      return;
    }
    const confirm = workBuddyPermission(message);
    if (!confirm) {
      void this.rpc?.respond(message.id, { outcome: { outcome: "cancelled" } }).catch(() => undefined);
      return;
    }
    if (this.permissions.has(message.id)) return;
    this.permissions.set(message.id, { confirm, answering: false });
    if (this.permissions.size === 1) this.emit({ type: "confirm", confirm });
  }

  async answerConfirmation(confirm: ChatConfirm, value: string | null): Promise<void> {
    const id = confirm.workbuddy?.requestId;
    const permission = id !== undefined ? this.permissions.get(id) : undefined;
    if (!permission || permission.answering || !this.rpc || this.cancelled) throw new Error(wt("workbuddy.cloud_request_expired", "这项确认已失效，请重新连接会话"));
    permission.answering = true;
    try {
      let outcome: Record<string, unknown> = { outcome: "cancelled" };
      if (value !== null) {
        if (permission.confirm.workbuddy?.questions?.length) {
          const answers = object(JSON.parse(value));
          for (const question of permission.confirm.workbuddy.questions) {
            const answer = answers[question.id];
            if (question.multiSelect ? !Array.isArray(answer) || !answer.length || !answer.every((entry) => typeof entry === "string" && !!entry.trim())
              : typeof answer !== "string" || !answer.trim()) throw new Error("Invalid WorkBuddy questionnaire answer");
          }
          const optionId = permission.confirm.options.find((option) => !/reject|cancel|deny/i.test(option.value))?.value;
          outcome = { outcome: "selected", ...(optionId ? { optionId } : {}), answers };
        } else {
          if (!permission.confirm.options.some((option) => option.value === value)) throw new Error("Invalid WorkBuddy permission option");
          outcome = { outcome: "selected", optionId: value };
        }
      }
      await this.rpc.respond(id!, { outcome });
      this.permissions.delete(id!);
      this.emit({ type: "confirm_resolved", requestId: id! });
      const next = this.permissions.values().next().value as Permission | undefined;
      if (next) this.emit({ type: "confirm", confirm: next.confirm });
    } catch (error) { permission.answering = false; throw error; }
  }

  private clearPermissions(): void {
    for (const id of this.permissions.keys()) this.emit({ type: "confirm_resolved", requestId: id });
    this.permissions.clear();
  }

  private async restoreArtifacts(): Promise<void> {
    if (!this.taskInfo) return;
    const revision = this.artifactRevision;
    try {
      for (const entry of await listWorkBuddyArtifacts(this.taskInfo)) {
        const attachment = workBuddyArtifact(entry, this.taskInfo.task_id);
        if (!attachment) continue;
        if ((this.artifactVersions.get(attachment.id!) ?? 0) > revision) continue;
        if (object(entry).event === "deleted") this.artifacts.delete(attachment.id!);
        else this.artifacts.set(attachment.id!, attachment);
      }
      if (this.artifacts.size) this.emit({ type: "meta", sources: [], attachments: [...this.artifacts.values()] });
    } catch { /* Artifact availability is independent of text chat. */ }
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    const rpc = this.rpc;
    if (!rpc) return;
    const writes = [...this.permissions.keys()].map((id) => rpc.respond(id, { outcome: { outcome: "cancelled" } }));
    if (this.phase === "prompting" && this.taskInfo) writes.push(rpc.notify("session/cancel", { sessionId: this.taskInfo.task_id }));
    this.permissions.clear();
    this.cancellation = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled(writes), new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000); })]);
      if (timer) clearTimeout(timer);
      await rpc.close().catch(() => undefined);
    })();
  }
}
