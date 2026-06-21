type ClientOptions = {
  onUnauthorized?: () => void;
  identity?: { platform?: string; version?: string; os?: string };
};

// All requests go through /api/proxy to avoid CORS issues.
// The proxy reads x-lynse-api-url to know where to forward.
const PROXY_PREFIX = "/api/proxy";

export class ApiClient {
  // The actual Lynse backend URL (e.g. http://api.lynse.cn)
  private backendUrl: string;
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

  setApiKey(apiKey: string | null) {
    this.apiKey = apiKey;
  }

  setBaseUrl(url: string) {
    this.backendUrl = url.replace(/\/+$/, "");
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Tell the proxy where to forward
      "X-Lynse-Api-Url": this.backendUrl,
      ...(options.headers as Record<string, string>),
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
    const url = `${PROXY_PREFIX}${path}`;

    const res = await fetch(url, {
      ...options,
      headers,
    });

    if (res.status === 401) {
      this.onUnauthorized?.();
      throw new ApiError(res.status, "Unauthorized");
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ApiError(res.status, body || res.statusText);
    }
    if (res.status === 204) return undefined as T;

    const json = await res.json();

    if (json && typeof json === "object" && "code" in json && "data" in json) {
      if (json.code !== 200) {
        throw new ApiError(json.code, json.msg || json.message || "API error");
      }
      return json.data as T;
    }

    return json as T;
  }

  get<T>(path: string) {
    return this.request<T>(path, { method: "GET" });
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

  post<T>(path: string, body?: unknown) {
    return this.request<T>(path, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
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
   * Returns an AbortController so the caller can cancel the stream.
   */
  stream(
    path: string,
    body: unknown,
    onChunk: (data: string) => void,
    onError?: (err: Error) => void,
  ): AbortController {
    const controller = new AbortController();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "X-Lynse-Api-Url": this.backendUrl,
    };
    if (this.token) headers["Authorization"] = this.token;
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    if (this.identity?.platform) headers["X-Client-Platform"] = this.identity.platform;

    const url = `${PROXY_PREFIX}${path}`;

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
        if ((err as Error).name === "AbortError") return;
        onError?.(err as Error);
      }
    })();

    return controller;
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
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
