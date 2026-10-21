import type { WikiModel } from "./types";

export const DEFAULT_EMBEDDING_MODEL: Readonly<WikiModel> = {
  baseUrl: "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  model: "qwen3.7-text-embedding",
};

export function embeddingModelError(model: WikiModel): string | null {
  const baseUrl = model.baseUrl.trim();
  if (!baseUrl && !model.model.trim()) return null;
  if (/[{}]/.test(baseUrl)) return "workbench.embedding_workspace_required";
  try {
    const url = new URL(baseUrl);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!url.hostname || url.username || url.password || url.search || url.hash
      || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
      return "workbench.embedding_invalid_url";
    }
  } catch {
    return "workbench.embedding_invalid_url";
  }
  return model.model.trim() ? null : "workbench.embedding_model_required";
}
