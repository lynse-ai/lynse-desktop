type ClientOptions = {
  onUnauthorized?: () => void;
  identity?: { platform?: string; version?: string; os?: string };
};

/** Per-call request additions beyond the standard fetch init. */
type RequestOptions = RequestInit & {
  /** Alternate backend origin for this one call. The AI-assistant chat
   *  transport uses it to target the dedicated agent server (route B direct
   *  CloudRun connection) while session credentials stay unchanged. */
  baseUrl?: string;
};

// All requests go through /api/proxy to avoid CORS issues.
// The proxy reads x-lynse-api-url to know where to forward.
const PROXY_PREFIX = "/api/proxy";
let apiTransportMode: "proxy" | "direct" = "proxy";

/** Gateway envelope code for missing/expired credentials ("Please provide
 *  authentication token") — arrives as HTTP 200, not a real 401. */
const GATEWAY_AUTH_ERROR_CODE = 2013;

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

export class ApiClient {
  // The actual Lynse backend URL — the address the user entered on the
  // login/API-config page (persisted as lynse_api_url). No default here.
  private backendUrl: string;
  // Optional dedicated origin for the AI assistant (lynse_agent_api_url).
  // Stored here only as the value the chat transport reads; it never changes
  // where regular business requests go.
  private agentBaseUrl: string | null = null;
  private token: string | null = null;
  private apiKey: string | null = null;
  private onUnauthorized?: () => void;
  private identity?: ClientOptions["identity"];

  constructor(backendUrl: string, opts: ClientOptions = {}) {
    this.backendUrl = backendUrl.replace(/\/+$/, "");
    this.onUnauthorized = opts.onUnauthorized;
    this.identity = opts.identity;
  }

  setToken(token: string | null) {
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
    this.backendUrl = url.replace(/\/+$/, "");
  }

  /** The configured backend origin (no trailing slash), e.g. `https://api.lynse.cn`. */
  getBaseUrl(): string {
    return this.backendUrl;
  }

  /** Point the AI assistant at a dedicated backend origin (null = follow the
   *  main backend). Persisted separately (lynse_agent_api_url); see core/config. */
  setAgentBaseUrl(url: string | null) {
    this.agentBaseUrl = url ? url.replace(/\/+$/, "") : null;
  }

  /** The dedicated AI-assistant origin, or null when unset. */
  getAgentBaseUrl(): string | null {
    return this.agentBaseUrl;
  }

  private async request<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const { baseUrl: overrideBase, ...init } = options;
    const baseUrl = overrideBase ?? this.backendUrl;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Tell the proxy where to forward
      "X-Lynse-Api-Url": baseUrl,
      ...(init.headers as Record<string, string>),
    };
    if (this.token) {
      headers["Authorization"] = this.token;
    }
    if (this.apiKey) {
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

    if (res.status === 401) {
      this.onUnauthorized?.();
      throw new ApiError(res.status, "Unauthorized");
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

    const json = await res.json();

    if (json && typeof json === "object" && "code" in json && "data" in json) {
      if (json.code !== 200) {
        // The gateway reports missing/expired credentials as an HTTP-200
        // envelope (e.g. code 2013 "Please provide authentication token")
        // instead of a real 401 — treat it as unauthorized so the session
        // drops and the app falls back to the launch page.
        if (json.code === GATEWAY_AUTH_ERROR_CODE) this.onUnauthorized?.();
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

  getWithParams<T>(path: string, params: Record<string, string | number | boolean | undefined>) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") {
        searchParams.set(key, String(value));
      }
    }
    const query = searchParams.toString();
    return this.request<T>(query ? `${path}?${query}` : path, { method: "GET" });
  }

  post<T>(path: string, body?: unknown, options?: RequestOptions) {
    return this.request<T>(path, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
      ...options,
    });
  }

  put<T>(path: string, body?: unknown) {
    return this.request<T>(path, {
      method: "PUT",
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  patch<T>(path: string, body?: unknown) {
    return this.request<T>(path, {
      method: "PATCH",
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  delete<T>(path: string) {
    return this.request<T>(path, { method: "DELETE" });
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
    options?: { baseUrl?: string },
  ): AbortController {
    const controller = new AbortController();
    const baseUrl = options?.baseUrl ?? this.backendUrl;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-Lynse-Api-Url": baseUrl,
    };
    if (this.token) headers["Authorization"] = this.token;
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    if (this.identity?.platform) headers["X-Client-Platform"] = this.identity.platform;

    const url = apiRequestUrl(baseUrl, path);

    (async () => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

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
