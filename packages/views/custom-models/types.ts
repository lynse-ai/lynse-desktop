/**
 * Shared BYO-model contracts for desktop features that run on the user's own
 * model (knowledge organization, local recording summaries, and future ones).
 * A profile names an OpenAI-compatible endpoint; its API key never leaves the
 * OS keychain (macOS Keychain / Windows Credential Manager) — the bridge only
 * ever passes the profile id, and the Rust side attaches the vaulted key at
 * request time.
 */

/** One user-configured model endpoint. Stored without any secret material. */
export interface CustomModelProfile {
  /** Stable slug ([a-zA-Z0-9_-], ≤64 chars); keys are vaulted under it. */
  id: string;
  /** User-visible name shown in pickers. */
  label: string;
  /** OpenAI-compatible base URL. Server-mediated features send it with the
   *  request; direct calls append `/chat/completions` to it. */
  baseUrl: string;
  model: string;
  createdAt: string;
}

export interface CustomModelCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CustomModelEndpoint {
  profileId: string;
  baseUrl: string;
  model: string;
}

export interface CustomModelCompletionRequest extends CustomModelEndpoint {
  messages: CustomModelCompletionMessage[];
  maxTokens?: number;
  temperature?: number;
}

/**
 * Bridge contract (`window.desktopAPI.customModels`), desktop only. Web
 * builds never install it and the manager card hides itself accordingly.
 */
export interface DesktopCustomModelsApi {
  setKey(profileId: string, apiKey: string | null): Promise<void>;
  hasKey(profileId: string): Promise<boolean>;
  testConnection(endpoint: CustomModelEndpoint): Promise<void>;
  complete(request: CustomModelCompletionRequest): Promise<string>;
}

/** Read the bridge instance; null on web builds or before installation. */
export function getCustomModelsApi(): DesktopCustomModelsApi | null {
  if (typeof window === "undefined") return null;
  return (
    (window as Window & { desktopAPI?: { customModels?: DesktopCustomModelsApi } })
      .desktopAPI?.customModels ?? null
  );
}
