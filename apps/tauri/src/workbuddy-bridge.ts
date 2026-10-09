import { Channel, invoke } from "@tauri-apps/api/core";
import { info as logInfo } from "@tauri-apps/plugin-log";
import { setWorkBuddyAuthorizationDiagnostics, setWorkBuddyHttpRelay, workBuddySessionGuard } from "@lynse/core/auth/workbuddy";
import {
  setWorkBuddyAcpBridge,
  setWorkBuddyResourceRelay,
  WorkBuddyAcpHttpError,
} from "@lynse/core/workbuddy";

type NativeEvent = { kind: "chunk"; bytes: number[] } | { kind: "closed" } | { kind: "error"; message: string };

function handshakeFailure(body: string | undefined, secrets: string[]): { code?: number; message: string } {
  let message = body ?? "HTTP error response unavailable";
  let code: number | undefined;
  try {
    const parsed = JSON.parse(message) as { error?: { code?: unknown; message?: unknown }; message?: unknown; msg?: unknown };
    if (typeof parsed.error?.code === "number") code = parsed.error.code;
    const detail = parsed.error?.message ?? parsed.message ?? parsed.msg;
    message = typeof detail === "string" ? detail : JSON.stringify(parsed);
  } catch { /* Some gateways return plain-text protocol errors. */ }
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[redacted]").split(encodeURIComponent(secret)).join("[redacted]");
  }
  message = message.replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted URL]")
    .replace(/\b(?:sk-|eyJ)[A-Za-z0-9._-]+/g, "[redacted]");
  return { code, message: message.slice(0, 1000) };
}

/** Native HTTP owns the long-lived SSE; core owns the protocol. */
export function installWorkBuddyBridge(): void {
  setWorkBuddyAuthorizationDiagnostics((diagnostics) => {
    void logInfo(`[workbuddy-auth] ${JSON.stringify(diagnostics)}`).catch(() => undefined);
  });
  setWorkBuddyHttpRelay((req) => invoke("workbuddy_openapi", { req }));
  setWorkBuddyResourceRelay((request) => invoke("workbuddy_cloud_resource", request));
  setWorkBuddyAcpBridge({
    async open(url, token, onEvent) {
      const assertSession = workBuddySessionGuard();
      const endpoint = new URL(url);
      void logInfo(`[workbuddy-acp] ${JSON.stringify({
        protocol: endpoint.protocol, hostname: endpoint.hostname, port: endpoint.port,
      })}`).catch(() => undefined);
      const decoder = new TextDecoder();
      const channel = new Channel<NativeEvent>();
      let closed = false;
      channel.onmessage = (event) => {
        if (closed) return;
        try { assertSession(); } catch {
          onEvent({ type: "error", message: "WorkBuddy session changed" });
          return;
        }
        if (event.kind === "chunk") {
          const data = decoder.decode(new Uint8Array(event.bytes), { stream: true });
          if (data) onEvent({ type: "data", data });
        } else if (event.kind === "error") onEvent({ type: "error", message: event.message });
        else {
          const tail = decoder.decode();
          if (tail) onEvent({ type: "data", data: tail });
          onEvent({ type: "closed" });
        }
      };
      const result = await invoke<{ status: number; handle?: string; connectionId?: string }>("workbuddy_acp_open", {
        url, token, onEvent: channel,
      });
      if (result.status < 200 || result.status >= 300) throw new WorkBuddyAcpHttpError(result.status);
      if (!result.handle || !result.connectionId) {
        if (result.handle) await invoke("workbuddy_acp_close", { handle: result.handle }).catch(() => undefined);
        throw new Error("WorkBuddy ACP connection ID missing");
      }
      const handle = result.handle;
      try { assertSession(); } catch (error) {
        closed = true;
        await invoke("workbuddy_acp_close", { handle }).catch(() => undefined);
        throw error;
      }
      return {
        async post(message) {
          assertSession();
          if (closed) throw new Error("WorkBuddy connection closed");
          const response = await invoke<{ status: number; body?: string }>("workbuddy_acp_post", { handle, body: JSON.stringify(message) });
          if (response.status >= 400 && message.method === "initialize") {
            // Initialize contains only client capabilities, never a user's prompt.
            const failure = handshakeFailure(response.body, [token, result.connectionId!, handle, url]);
            void logInfo(`[workbuddy-acp-initialize] ${JSON.stringify({ status: response.status, ...failure })}`).catch(() => undefined);
          }
          if (response.status < 200 || response.status >= 300) throw new WorkBuddyAcpHttpError(response.status);
          if (response.status === 200 && response.body && !closed) {
            assertSession();
            let data: string | undefined;
            let rpcResponse = false;
            let matchesRequest = false;
            let stopReasonPresent = false;
            try {
              const parsed: unknown = JSON.parse(response.body);
              const messages = (Array.isArray(parsed) ? parsed : [parsed]).filter((value): value is Record<string, unknown> => {
                if (!value || typeof value !== "object") return false;
                const rpc = value as Record<string, unknown>;
                return rpc.jsonrpc === "2.0" && (typeof rpc.id === "string" || typeof rpc.id === "number")
                  && ("result" in rpc || "error" in rpc);
              });
              rpcResponse = messages.length > 0;
              matchesRequest = messages.some((value) => value.id === message.id);
              stopReasonPresent = messages.some((value) => value.result && typeof value.result === "object" && "stopReason" in value.result);
              if (rpcResponse) data = `data: ${JSON.stringify(messages)}\n\n`;
            } catch {
              if (/(?:^|\n)data:/.test(response.body)) data = `${response.body}\n\n`;
            }
            const method = ["initialize", "session/load", "session/prompt", "session/cancel"].includes(message.method ?? "")
              ? message.method : "other";
            void logInfo(`[workbuddy-acp-post] ${JSON.stringify({ method, rpcResponse, matchesRequest, stopReasonPresent, sse: data?.startsWith(response.body) === true })}`).catch(() => undefined);
            // HTTP 202 and generic HTTP 200 acknowledgements never finish RPC.
            if (data) onEvent({ type: "data", data });
          }
        },
        async close() {
          if (closed) return;
          closed = true;
          await invoke("workbuddy_acp_close", { handle });
        },
      };
    },
  });
}
