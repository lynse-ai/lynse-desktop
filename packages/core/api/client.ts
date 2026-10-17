type ClientOptions = {
  onUnauthorized?: () => void;
  identity?: { platform?: string; version?: string; os?: string };
};

/** Per-call request additions beyond the standard fetch init. */
type RequestOptions = RequestInit & {
  /** Alternate backend origin for this one call. The AI-assistant chat
   *  transport uses it to target the dedicated agent server (route B direct
   *  CloudBase connection) while session credentials stay unchanged. */
  baseUrl?: string;
  /** Auxiliary services cannot expire the main login; only integrations use Bearer tokens. */
  authScope?: "session" | "integration" | "assistant";
  /** Context APIs require a current login token and never send deployment/API keys. */
  tokenOnly?: boolean;
  /** Bind a request to the session which started it; reject account changes. */
  sessionToken?: string;
  responseType?: "json" | "blob";
};

// All requests go through /api/proxy to avoid CORS issues.
// The proxy reads x-lynse-api-url to know where to forward.
const PROXY_PREFIX = "/api/proxy";
let apiTransportMode: "proxy" | "direct" = "proxy";

/** Gateway envelope code for missing/expired credentials ("Please provide
 *  authentication token") — arrives as HTTP 200, not a real 401. */
const GATEWAY_AUTH_ERROR_CODE = 2013;
/** Same gateway family reports an existing-but-dead session as 2000 ("User
 *  is not logged in or session has expired"). Left unhandled the UI silently
 *  keeps showing stale authenticated data: queries retain their last
 *  successful payload while every refetch fails. */
const GATEWAY_SESSION_EXPIRED_CODE = 2000;

/**
 * Desktop shells that provide a native fetch implementation can bypass the
 * browser-only development proxy while the web app keeps its existing route.
 */
export function setApiTransportMode(mode: "proxy" | "direct") {
  apiTransportMode = mode;
}

function apiRequestUrl(backendUrl: string, path: string): string {
  return apiTransportMode === "direct" ? `${backendUrl}${path}` : `${PROXY_PREFIX}${path}`;
}

/** Bound waits even when a native fetch adapter does not settle on abort. */
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Request aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

export class ApiClient {
  // The actual Lynse backend URL — the address the user entered on the
  // login/API-config page (persisted as lynse_api_url). No default here.
  private backendUrl: string;
  // Optional dedicated origin for the AI assistant (lynse_agent_api_url).
  // Stored here only as the value the chat transport reads; it never changes
  // where regular business requests go.
  private agentBaseUrl: string | null = null;
  // Optional dedicated origin for the Connections BFF (lynse_integrations_api_url).
  // Same story: integrations calls override per-request; business calls don't move.
  private integrationsBaseUrl: string | null = null;
  private token: string | null = null;
  private apiKey: string | null = null;
  private agentSession: { controller: AbortController; promise: Promise<void> } | null = null;
  private sessionRevision = 0;
  private onUnauthorized?: () => void;
  private identity?: ClientOptions["identity"];

  constructor(backendUrl: string, opts: ClientOptions = {}) {
    this.backendUrl = backendUrl.replace(/\/+$/, "");
    this.onUnauthorized = opts.onUnauthorized;
    this.identity = opts.identity;
  }

  setToken(token: string | null) {
    this.clearAgentSession();
    this.token = token;
  }

  /** Current session's access token, or null when logged out. */
  getToken(): string | null {
    return this.token;
  }

  setApiKey(apiKey: string | null) {
    this.apiKey = apiKey;
  }

  setBaseUrl(url: string) {
    const normalized = url.replace(/\/+$/, "");
    if (normalized !== this.backendUrl) this.clearAgentSession();
    this.backendUrl = normalized;
  }

  /** The configured backend origin (no trailing slash), e.g. `https://api.lynse.cn`. */
  getBaseUrl(): string {
    return this.backendUrl;
  }

  /** Point the AI assistant at a dedicated backend origin (null = follow the
   *  main backend). Persisted separately (lynse_agent_api_url); see core/config. */
  setAgentBaseUrl(url: string | null) {
    const normalized = url ? url.replace(/\/+$/, "") : null;
    if (normalized !== this.agentBaseUrl) this.clearAgentSession();
    this.agentBaseUrl = normalized;
  }

  /** The dedicated AI-assistant origin, or null when unset. */
  getAgentBaseUrl(): string | null {
    return this.agentBaseUrl;
  }

  /** Point the Connections BFF at a dedicated origin (null = follow the main
   *  backend). Persisted separately (lynse_integrations_api_url); see core/config. */
  setIntegrationsBaseUrl(url: string | null) {
    // Trim before stripping trailing slashes: a pasted value with stray
    // whitespace/newlines would otherwise produce an unparseable fetch URL
    // (WKWebView: "The string did not match the expected pattern.").
    const trimmed = url?.trim() || null;
    this.integrationsBaseUrl = trimmed ? trimmed.replace(/\/+$/, "") : null;
  }

  /** The dedicated Connections-BFF origin, or null when unset. */
  getIntegrationsBaseUrl(): string | null {
    return this.integrationsBaseUrl;
  }

  private clearAgentSession() {
    this.sessionRevision += 1;
    this.agentSession?.controller.abort();
    this.agentSession = null;
  }

  /** Share login registration with chat preflight; failures can be retried by the next turn. */
  ensureAgentSession(): Promise<void> {
    const host = this.backendUrl;
    const agentUrl = this.agentBaseUrl;
    const token = this.token;
    if (!agentUrl || !host) return Promise.resolve();
    if (!token) return Promise.reject(new ApiError(401, "Session changed or unavailable"));
    if (this.agentSession) return this.agentSession.promise;
    const state = { controller: new AbortController(), promise: Promise.resolve() };
    this.agentSession = state;
    state.promise = this.registerAgentSession(host, agentUrl, token, state.controller.signal).catch((error: unknown) => {
      if (this.agentSession === state) this.agentSession = null;
      throw error;
    });
    return state.promise;
  }

  private async registerAgentSession(host: string, agentUrl: string, token: string, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      const timeout = setTimeout(abort, 8_000);
      let retry = false;
      try {
        if (controller.signal.aborted) throw new DOMException("Request aborted", "AbortError");
        const result = await withAbort(this.request<{ host: string; user_id: string }>("/api/session/backend", {
          method: "POST", body: JSON.stringify({ host }), baseUrl: agentUrl,
          tokenOnly: true, sessionToken: token, authScope: "assistant", signal: controller.signal,
        }), controller.signal);
        if (result?.host?.replace(/\/+$/, "") !== host || !result?.user_id?.trim()) {
          throw new ApiError(412, "助手未能确认当前服务器，请稍后重试");
        }
        return;
      } catch (error) {
        if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
        retry = attempt < 2 && (!(error instanceof ApiError) || error.status === 429 || (error.status >= 500 && error.status < 600));
        if (!retry) {
          const message = error instanceof ApiError && error.status === 400
            ? "助手无法连接当前服务器，请检查助手的服务器配置"
            : error instanceof ApiError && [404, 405].includes(error.status)
              ? "助手服务需要更新，请更新后重试"
            : error instanceof ApiError && [401, 403, 2000, 2013].includes(error.status)
              ? "助手登录验证失败，请重新登录后重试"
              : "助手连接尚未完成，请稍后重试";
          // A terminal preflight error must not trigger stream-to-poll resubmission.
          throw new ApiError(412, message);
        }
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
      }
      if (retry) {
        await new Promise<void>((resolve, reject) => {
          const abortWait = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abortWait);
            reject(new DOMException("Request aborted", "AbortError"));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abortWait);
            resolve();
          }, 1_000 * 2 ** attempt);
          signal.addEventListener("abort", abortWait, { once: true });
          if (signal.aborted) abortWait();
        });
      }
    }
  }

  private isAgentChat(path: string, baseUrl: string) {
    return !!this.agentBaseUrl && baseUrl === this.agentBaseUrl && /^\/api\/chat(?:\/|$)/.test(path);
  }

  private async waitForAgentSession(revision: number, signal?: AbortSignal | null) {
    try {
      await withAbort(this.ensureAgentSession(), signal);
    } catch (error) {
      if (!signal?.aborted && revision !== this.sessionRevision) {
        throw new ApiError(401, "Session changed or unavailable");
      }
      throw error;
    }
  }

  private async request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const { baseUrl: overrideBase, authScope = "session", tokenOnly, sessionToken, responseType, ...init } = options;
    const integrationAuth = authScope === "integration";
    const requestToken = this.token;
    const revision = this.sessionRevision;
    const baseUrl = overrideBase ?? this.backendUrl;
    const agentChat = this.isAgentChat(path, baseUrl);
    const requireToken = tokenOnly || agentChat;
    if ((requireToken && !requestToken) || (sessionToken !== undefined && sessionToken !== requestToken)) {
      throw new ApiError(401, "Session changed or unavailable");
    }
    if (init.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    if (agentChat) await this.waitForAgentSession(revision, init.signal);
    if (init.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    if (requireToken && (this.token !== requestToken || this.sessionRevision !== revision)) throw new ApiError(401, "Session changed or unavailable");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Tell the proxy where to forward
      "X-Lynse-Api-Url": baseUrl,
      ...(init.headers as Record<string, string>),
    };
    if (requestToken) {
      headers["Authorization"] = integrationAuth ? `Bearer ${requestToken}` : requestToken;
    }
    if (this.apiKey && !requireToken && !integrationAuth) {
      headers["X-API-Key"] = this.apiKey;
    }
    if (this.identity?.platform) {
      headers["X-Client-Platform"] = this.identity.platform;
    }

    // Route through local proxy
    const url = apiRequestUrl(baseUrl, path);

    const res = await fetch(url, {
      ...init,
      headers,
    });
    if (requireToken && (this.token !== requestToken || this.sessionRevision !== revision)) {
      throw new ApiError(401, "Session changed or unavailable");
    }

    if (res.status === 401) {
      if (authScope === "session") {
        this.onUnauthorized?.();
        throw new ApiError(res.status, "Unauthorized");
      }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Gateways often wrap failures in the same { code, msg } envelope even
      // with a non-200 HTTP status — surface `msg` instead of the raw JSON.
      let message = body || res.statusText;
      let data: unknown;
      try {
        const json = JSON.parse(body) as {
          msg?: unknown;
          message?: unknown;
          data?: unknown;
        };
        if (typeof json.msg === "string" && json.msg) {
          message = json.msg;
          data = json.data;
        } else if (typeof json.message === "string" && json.message) {
          message = json.message;
          data = json.data;
        }
      } catch {
        // Not JSON — keep the raw body as the message.
      }
      throw new ApiError(res.status, message, data);
    }
    if (res.status === 204) return undefined as T;
    if (responseType === "blob") return await res.blob() as T;

    const json = await res.json();
    if (requireToken && (this.token !== requestToken || this.sessionRevision !== revision)) {
      throw new ApiError(401, "Session changed or unavailable");
    }

    if (json && typeof json === "object" && "code" in json && "data" in json) {
      if (json.code !== 200) {
        // The gateway reports missing/expired credentials as HTTP-200
        // envelopes (2013 "Please provide authentication token", 2000 "User
        // is not logged in or session has expired") instead of a real 401 —
        // treat both as unauthorized so the session drops and the app falls
        // back to the launch page. The message check is a safety net for
        // sibling gateways that phrase the same condition under other codes.
        const envelopeMessage =
          typeof json.msg === "string" ? json.msg : typeof json.message === "string" ? json.message : "";
        if (authScope === "session" && (
          json.code === GATEWAY_AUTH_ERROR_CODE ||
          json.code === GATEWAY_SESSION_EXPIRED_CODE ||
          /not logged in|session has expired/i.test(envelopeMessage)
        )) {
          this.onUnauthorized?.();
        }
        // `data` may carry useful fields even on failure (e.g. `cooldown`
        // alongside error.operation.too.frequent).
        throw new ApiError(
          json.code,
          json.msg || json.message || "API error",
          json.data,
        );
      }
      return json.data as T;
    }

    return json as T;
  }

  get<T>(path: string, options?: RequestOptions) {
    return this.request<T>(path, { method: "GET", ...options });
  }

  getBlob(path: string, options?: RequestOptions) {
    return this.request<Blob>(path, { method: "GET", ...options, responseType: "blob" });
  }

  getWithParams<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    options?: RequestOptions,
  ) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        searchParams.set(key, String(value));
      }
    }
    const query = searchParams.toString();
    return this.request<T>(query ? `${path}?${query}` : path, { method: "GET", ...options });
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>(path, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
      ...options,
    });
  }

  put<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>(path, {
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
      ...options,
    });
  }

  patch<T>(path: string, body?: unknown) {
    return this.request<T>(path, {
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  delete<T>(path: string, options?: RequestOptions) {
    return this.request<T>(path, { method: "DELETE", ...options });
  }

  /**
   * Stream SSE responses. Calls `onChunk` for each `data:` line received.
   * Returns an AbortController so the caller can cancel the stream. `onComplete`
   * runs after the response closes or is aborted. `options.baseUrl` targets a
   * different backend origin for this stream (AI-assistant direct connection).
   */
  stream(
    path: string,
    body: unknown,
    onChunk: (data: string) => void,
    onError?: (err: Error) => void,
    onComplete?: () => void,
    options?: { baseUrl?: string; sessionToken?: string },
  ): AbortController {
    const controller = new AbortController();
    const baseUrl = options?.baseUrl ?? this.backendUrl;
    const requestToken = this.token;
    const revision = this.sessionRevision;
    const agentChat = this.isAgentChat(path, baseUrl);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-Lynse-Api-Url": baseUrl,
    };
    if (requestToken) headers["Authorization"] = requestToken;
    if (this.apiKey && !agentChat) headers["X-API-Key"] = this.apiKey;
    if (this.identity?.platform) headers["X-Client-Platform"] = this.identity.platform;

    const url = apiRequestUrl(baseUrl, path);

    (async () => {
      try {
        if ((agentChat && !requestToken) || (options?.sessionToken !== undefined && options.sessionToken !== requestToken)) {
          throw new ApiError(401, "Session changed or unavailable");
        }
        if (agentChat) await this.waitForAgentSession(revision, controller.signal);
        if (controller.signal.aborted) throw new DOMException("Request aborted", "AbortError");
        if (agentChat && (this.token !== requestToken || this.sessionRevision !== revision)) throw new ApiError(401, "Session changed or unavailable");
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (agentChat && (this.token !== requestToken || this.sessionRevision !== revision)) throw new ApiError(401, "Session changed or unavailable");

        if (res.status === 401) {
          this.onUnauthorized?.();
          throw new ApiError(res.status, "Unauthorized");
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          console.error(`[api-stream] ${res.status} response:`, text.slice(0, 500));
          throw new ApiError(res.status, text || res.statusText);
        }

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (agentChat && (this.token !== requestToken || this.sessionRevision !== revision)) throw new ApiError(401, "Session changed or unavailable");
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data:")) {
              const payload = trimmed.slice(5).trim();
              if (payload === "[DONE]") continue;
              onChunk(payload);
            }
          }
        }

        // Flush remaining buffer
        if (buffer.trim()) {
          const trimmed = buffer.trim();
          if (trimmed.startsWith("data:")) {
            const payload = trimmed.slice(5).trim();
            if (payload !== "[DONE]") onChunk(payload);
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          onComplete?.();
          return;
        }
        onError?.(err as Error);
        return;
      }

      onComplete?.();
    })();

    return controller;
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let apiInstance: ApiClient | null = null;

export function setApiInstance(api: ApiClient) {
  apiInstance = api;
}

export function api(): ApiClient {
  if (!apiInstance) throw new Error("API client not initialized");
  return apiInstance;
}
