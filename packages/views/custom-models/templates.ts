/**
 * User-authored summary templates, stored locally. Cloud templates keep their
 * prompts server-side, so a user who wants a fully off-cloud pipeline (local
 * transcription + their own model) writes templates here and picks them in
 * the summary dialog's custom-model section.
 */

import { isHttpUrl } from "../workspace/model-override";

export interface CustomSummaryTemplate {
  /** Stable slug; reused on update. */
  id: string;
  name: string;
  /** The prompt sent as the system message to the user's own model. */
  prompt: string;
  createdAt: string;
}

const STORAGE_KEY = "lynse_custom_templates";
const MAX_TEMPLATES = 50;
const MAX_PROMPT_CHARS = 20_000;

/** Absent/corrupt storage yields an empty list — never throw. */
export function loadCustomTemplates(): CustomSummaryTemplate[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTemplate);
  } catch {
    return [];
  }
}

export function getCustomTemplate(id: string): CustomSummaryTemplate | null {
  return loadCustomTemplates().find((template) => template.id === id) ?? null;
}

function isTemplate(value: unknown): value is CustomSummaryTemplate {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === "string" && !!v.id &&
    typeof v.name === "string" && !!v.name &&
    typeof v.prompt === "string" && !!v.prompt.trim() &&
    typeof v.createdAt === "string";
}

export function saveCustomTemplate(template: CustomSummaryTemplate): CustomSummaryTemplate[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const templates = loadCustomTemplates();
    const at = templates.findIndex((existing) => existing.id === template.id);
    if (at >= 0) templates[at] = template;
    else templates.unshift(template);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(templates.slice(0, MAX_TEMPLATES)));
  } catch {
    // Storage unavailable: the template just won't persist.
  }
  return loadCustomTemplates();
}

export function removeCustomTemplate(id: string): CustomSummaryTemplate[] {
  if (typeof localStorage === "undefined") return [];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(
      loadCustomTemplates().filter((template) => template.id !== id),
    ));
  } catch {
    // Ignore; the list stays as-is.
  }
  return loadCustomTemplates();
}

export function isValidTemplatePrompt(prompt: string): boolean {
  return !!prompt.trim() && prompt.length <= MAX_PROMPT_CHARS;
}

// Re-exported so the dialog and executor share one URL rule with profiles.
export { isHttpUrl };
