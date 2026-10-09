import { object } from "./api";

export type RpcId = string | number;
export interface RpcMessage {
  jsonrpc: "2.0";
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export type WorkBuddyAcpEvent =
  | { type: "data"; data: string }
  | { type: "closed" }
  | { type: "error"; message: string };

export interface WorkBuddyAcpConnection {
  post(message: RpcMessage): Promise<void>;
  close(): Promise<void>;
}

export interface WorkBuddyAcpBridge {
  open(url: string, token: string, onEvent: (event: WorkBuddyAcpEvent) => void): Promise<WorkBuddyAcpConnection>;
}

let bridge: WorkBuddyAcpBridge | null = null;
export function setWorkBuddyAcpBridge(value: WorkBuddyAcpBridge | null): void { bridge = value; }
export function hasWorkBuddyAcpBridge(): boolean { return bridge !== null; }

export class WorkBuddyAcpHttpError extends Error {
  constructor(readonly status: number) {
    super(`WorkBuddy ACP request failed (${status})`);
    this.name = "WorkBuddyAcpHttpError";
  }
}

/** Incremental SSE framing, including CRLF and multi-line data fields. */
export class WorkBuddySseParser {
  private buffer = "";
  private data: string[] = [];
  private frameSize = 0;
  constructor(private readonly onData: (data: string) => void) {}
  push(chunk: string): void {
    this.buffer += chunk;
    let at: number;
    while ((at = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, at).replace(/\r$/, "");
      this.buffer = this.buffer.slice(at + 1);
      if (!line) {
        if (this.data.length) this.onData(this.data.join("\n"));
        this.data = [];
        this.frameSize = 0;
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).replace(/^ /, "");
        this.data.push(value);
        this.frameSize += value.length;
      }
      if (this.frameSize > 2_000_000) throw new Error("WorkBuddy SSE event too large");
    }
    if (this.buffer.length + this.frameSize > 2_000_000) throw new Error("WorkBuddy SSE event too large");
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** ACP v1 RPC correlation. POST acknowledgement is never turn completion. */
export class WorkBuddyAcpClient {
  private connection: WorkBuddyAcpConnection | null = null;
  private pending = new Map<RpcId, PendingRequest>();
  private sequence = 0;
  private stopped = false;
  private failure: Error | null = null;
  private parser = new WorkBuddySseParser((data) => this.receive(data));

  constructor(
    private readonly onNotification: (message: RpcMessage) => void,
    private readonly onRequest: (message: RpcMessage) => void,
    private readonly onFailure?: (error: Error) => void,
  ) {}

  async connect(url: string, token: string): Promise<void> {
    if (!bridge) throw new Error("WorkBuddy desktop bridge unavailable");
    const connection = await bridge.open(url, token, (event) => {
      if (this.stopped) return;
      try {
        if (event.type === "data") this.parser.push(event.data);
        else this.fail(new Error(event.type === "error" ? event.message : "WorkBuddy connection interrupted"));
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    if (this.stopped || this.failure) {
      await connection.close();
      throw this.failure ?? new Error("cancelled");
    }
    this.connection = connection;
  }

  private fail(error: Error): void {
    if (this.failure || this.stopped) return;
    this.failure = error;
    this.pending.forEach((request) => { clearTimeout(request.timer); request.reject(error); });
    this.pending.clear();
    this.onFailure?.(error);
  }

  private receive(data: string): void {
    if (data === "[DONE]") return;
    const parsed: unknown = JSON.parse(data);
    for (const value of Array.isArray(parsed) ? parsed : [parsed]) {
      const root = object(value);
      if (root.jsonrpc !== "2.0") continue;
      const message = root as unknown as RpcMessage;
      if (typeof message.method === "string") {
        if (message.id !== undefined) this.onRequest(message);
        else this.onNotification(message);
      } else if (message.id !== undefined) {
        const request = this.pending.get(message.id);
        if (!request) continue;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      }
    }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (this.stopped || this.failure || !this.connection) return Promise.reject(this.failure ?? new Error("cancelled"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`WorkBuddy ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      void this.connection!.post({ jsonrpc: "2.0", id, method, params }).catch((error: unknown) => {
        const request = this.pending.get(id);
        if (!request) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async respond(id: RpcId, result: unknown): Promise<void> {
    if (this.stopped || this.failure || !this.connection) throw this.failure ?? new Error("cancelled");
    await this.connection.post({ jsonrpc: "2.0", id, result });
  }

  async rejectRequest(id: RpcId): Promise<void> {
    await this.connection?.post({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unsupported client method" } });
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.connection?.post({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.pending.forEach((request) => { clearTimeout(request.timer); request.reject(new Error("cancelled")); });
    this.pending.clear();
    await this.connection?.close();
  }
}
