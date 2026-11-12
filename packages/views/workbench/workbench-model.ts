/**
 * Which custom model knowledge organization runs on. Only the profile id is
 * persisted here; routing fields resolve through the shared custom-models
 * store and the API key stays in the OS keychain — the desktop attaches it
 * per request, so neither this binding nor the workbench session ever holds
 * a secret.
 */

import { getCustomModel, toModelOverride } from "../custom-models";

const STORAGE_KEY = "lynse_workbench_model_binding";

/** Local storage key, exported for cross-window change listeners. */
export const WORKBENCH_MODEL_STORAGE_KEY = STORAGE_KEY;

/** Emitted after the binding changes so open pickers can refresh. */
export const WORKBENCH_MODEL_CHANGED_EVENT = "lynse-workbench-model-binding";

export function loadWorkbenchModelBinding(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

export function saveWorkbenchModelBinding(profileId: string | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (profileId) localStorage.setItem(STORAGE_KEY, profileId);
    else localStorage.removeItem(STORAGE_KEY);
    if (typeof window !== "undefined") window.dispatchEvent(new Event(WORKBENCH_MODEL_CHANGED_EVENT));
  } catch {
    // Storage unavailable: the binding just won't persist.
  }
}

/**
 * The full override for the workbench session: routing fields plus the
 * profile reference the desktop resolves to a vaulted key at request time.
 * Null when nothing is bound or the bound profile was deleted.
 */
export function resolveWorkbenchModelOverride():
  | { preset?: string; baseUrl?: string; model: string; profileId: string }
  | null {
  const id = loadWorkbenchModelBinding();
  if (!id) return null;
  const profile = getCustomModel(id);
  return profile ? toModelOverride(profile) : null;
}
