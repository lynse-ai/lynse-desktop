/**
 * Local profile store for custom models. Profiles carry routing fields only
 * (label/preset/baseUrl/model) in localStorage; API keys live in the OS
 * keychain via the desktop bridge and are never written here.
 */

import { isHttpUrl } from "../workspace/model-override";
import type { CustomModelEndpoint, CustomModelProfile } from "./types";

const STORAGE_KEY = "lynse_custom_models";

/** Local storage key, exported for cross-window change listeners. */
export const CUSTOM_MODELS_STORAGE_KEY = STORAGE_KEY;

/** Emitted after every successful write so open pickers can refresh. */
export const CUSTOM_MODELS_CHANGED_EVENT = "lynse-custom-models-changed";

const MAX_PROFILES = 20;

/** Absent/corrupt storage yields an empty list — never throw. */
export function loadCustomModels(): CustomModelProfile[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCustomModelProfile);
  } catch {
    return [];
  }
}

export function getCustomModel(id: string): CustomModelProfile | null {
  return loadCustomModels().find((profile) => profile.id === id) ?? null;
}

/** Coerce untrusted JSON; anything malformed is dropped, not rejected. */
function isCustomModelProfile(value: unknown): value is CustomModelProfile {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && !!v.id &&
    typeof v.label === "string" && !!v.label &&
    typeof v.baseUrl === "string" && isHttpUrl(v.baseUrl) &&
    typeof v.model === "string" && !!v.model &&
    typeof v.createdAt === "string";
}

export function saveCustomModels(models: CustomModelProfile[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(models.slice(0, MAX_PROFILES)));
    if (typeof window !== "undefined") window.dispatchEvent(new Event(CUSTOM_MODELS_CHANGED_EVENT));
  } catch {
    // Storage unavailable (quota/private mode): the change just won't persist.
  }
}

export function upsertCustomModel(profile: CustomModelProfile): CustomModelProfile[] {
  const models = loadCustomModels();
  const at = models.findIndex((existing) => existing.id === profile.id);
  if (at >= 0) models[at] = profile;
  else models.push(profile);
  saveCustomModels(models);
  return models;
}

export function removeCustomModel(id: string): CustomModelProfile[] {
  const models = loadCustomModels().filter((profile) => profile.id !== id);
  saveCustomModels(models);
  return models;
}

export function isValidProfileId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

/**
 * Wire shape for server-mediated features (knowledge organization): the
 * explicit endpoint plus the profile reference. No apiKey — the desktop
 * attaches the vaulted key per request; no preset — the endpoint always
 * travels with the profile.
 */
export function toModelOverride(profile: CustomModelProfile): {
  baseUrl: string;
  model: string;
  profileId: string;
} {
  return { baseUrl: profile.baseUrl, model: profile.model, profileId: profile.id };
}

/** Direct-call request prefix (off-cloud features): base URL + model. */
export function toCompletionBase(profile: CustomModelProfile): CustomModelEndpoint {
  return { profileId: profile.id, baseUrl: profile.baseUrl, model: profile.model };
}

/** Generate a unique slug from a label; callers pass their own candidates. */
export function suggestProfileId(label: string): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "model";
  const existing = new Set(loadCustomModels().map((profile) => profile.id));
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
