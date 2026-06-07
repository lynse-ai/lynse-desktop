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
        throw new ApiError(json.code, json.message || "API error");
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
