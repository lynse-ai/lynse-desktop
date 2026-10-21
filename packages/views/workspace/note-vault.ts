"use client";

import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@lynse/core/api/client";
import { useTranslation } from "@lynse/core/i18n/react";
import TurndownService from "turndown";
import { isLocalFileId } from "./local-transcription";
import type { FileConclusion, FileOutline } from "./types";

/** Desktop-only local vault bridge (`window.desktopAPI.vault`). Absent on web. */
export interface DesktopVaultApi {
  getConfig: () => Promise<VaultConfig>;
  saveConfig: (config: VaultConfig) => Promise<VaultConfig>;
  getDefaultPath: () => Promise<string>;
  pickDirectory: () => Promise<string | null>;
  writeNote: (note: VaultNotePayload) => Promise<void>;
  writeNotes: (notes: VaultNotePayload[]) => Promise<VaultBatchSummary>;
  readNote: (fileId: string) => Promise<string | null>;
  removeNote: (fileId: string) => Promise<void>;
  /** Reveal the vault folder in the system file manager. */
  openVaultFolder: (path: string) => Promise<void>;
  /** Subscribe to `vault-sync-progress` events; returns an unlisten fn. */
  onSyncProgress: (callback: (progress: VaultSyncProgress) => void) => Promise<() => void>;
}

export interface VaultConfig {
  enabled: boolean;
  path?: string | null;
}

export interface VaultNotePayload {
  fileId: string;
  title: string;
  markdown: string;
}

export interface VaultBatchSummary {
  written: number;
  reused?: number;
  failed: number;
  errors: string[];
}

export interface VaultSyncProgress {
  done: number;
  total: number;
  title: string;
}

export function getDesktopVaultApi(): DesktopVaultApi | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & {
    desktopAPI?: { vault?: DesktopVaultApi };
  };
  return desktopWindow.desktopAPI?.vault ?? null;
}

export function isHtmlContent(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<") && /<\/\w+>/.test(trimmed);
}

/** Localized headings for the assembled markdown document. */
export interface VaultSectionLabels {
  outline: string;
  summary: string;
}

export const VAULT_DEFAULT_SECTION_LABELS: VaultSectionLabels = {
  outline: "Outline",
  summary: "Summary",
};

export interface VaultNoteSectionInput {
  id: string;
  name?: string | null;
  text: string;
}

export interface VaultNoteContentInput {
  fileId: string;
  title: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  /** Raw outline text as returned by the API (HTML document or markdown). */
  outlineText?: string | null;
  conclusions?: VaultNoteSectionInput[];
  labels?: Partial<VaultSectionLabels>;
}

const VAULT_SOURCE_TAG = "lynse";
const VAULT_WRITE_DEBOUNCE_MS = 2000;
const VAULT_SYNC_CHUNK_SIZE = 20;

/** YAML double-quoted scalar; JSON escaping is a valid YAML subset. */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

let turndownService: TurndownService | null = null;

function getTurndown(): TurndownService {
  if (!turndownService) {
    turndownService = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
  }
  return turndownService;
}

function stripHtmlDocument(html: string): string {
  // Outline content can be a full HTML document; keep only the markup so
  // <style>/<script> text never leaks into the markdown.
  return html
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(head|body|html)\b[^>]*>/gi, "");
}

function contentToMarkdown(content: string): string {
  const text = content.trim();
  if (!text) return "";
  if (!isHtmlContent(text)) return text;
  try {
    return getTurndown().turndown(stripHtmlDocument(text)).trim();
  } catch {
    return text;
  }
}

/**
 * Assemble one vault file per note: Obsidian-compatible YAML frontmatter,
 * an H1 from the note title, then outline and summary sections as markdown.
 * Returns null when the note has no content worth mirroring yet.
 */
export function buildNoteMarkdown(input: VaultNoteContentInput): VaultNotePayload | null {
  const labels = { ...VAULT_DEFAULT_SECTION_LABELS, ...input.labels };
  const sections: string[] = [];

  const outlineMarkdown = input.outlineText ? contentToMarkdown(input.outlineText) : "";
  if (outlineMarkdown) {
    sections.push(`## ${labels.outline}\n\n${outlineMarkdown}`);
  }

  const seenNames = new Set<string>();
  (input.conclusions ?? []).forEach((conclusion, index) => {
    const markdown = contentToMarkdown(conclusion.text ?? "");
    if (!markdown) return;
    const baseName = conclusion.name?.trim() || `${labels.summary} ${index + 1}`;
    let name = baseName;
    let suffix = 2;
    while (seenNames.has(name)) {
      name = `${baseName} (${suffix++})`;
    }
    seenNames.add(name);
    sections.push(`## ${name}\n\n${markdown}`);
  });

  if (sections.length === 0) return null;

  const frontmatterLines = [
    "---",
    `id: ${yamlString(input.fileId)}`,
    `title: ${yamlString(input.title)}`,
    ...(input.createdAt ? [`created: ${yamlString(input.createdAt)}`] : []),
    ...(input.updatedAt ? [`updated: ${yamlString(input.updatedAt)}`] : []),
    `source: ${VAULT_SOURCE_TAG}`,
    "tags:",
    `  - ${VAULT_SOURCE_TAG}`,
    "---",
  ];

  const markdown = [
    ...frontmatterLines,
    "",
    `# ${input.title}`,
    "",
    ...sections.map((section) => `${section}\n`),
  ].join("\n");

  return { fileId: input.fileId, title: input.title, markdown };
}

/** Remove a leading YAML frontmatter block so the body renders cleanly in a
 *  markdown viewer (offline fallback). */
export function stripVaultFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? markdown.slice(match[0].length) : markdown;
}

export const VAULT_CONFIG_QUERY_KEY = ["vault-config"] as const;

export function useVaultConfig() {
  const vaultApi = getDesktopVaultApi();
  return useQuery({
    queryKey: VAULT_CONFIG_QUERY_KEY,
    queryFn: () => vaultApi!.getConfig(),
    enabled: !!vaultApi,
    staleTime: Infinity,
  });
}

/**
 * Mirror the currently open note (outline + summaries) into the local vault.
 * One-way cloud→local, desktop only, silently ignored elsewhere. Edits flow
 * through without extra wiring: saving a conclusion invalidates the
 * `file-conclusions` query, the new data re-runs this effect, and the file is
 * rewritten after a short debounce.
 */
export function useNoteVaultSync(options: {
  fileId: string | null;
  title: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  outlineText?: string | null;
  conclusions: VaultNoteSectionInput[];
}) {
  const { fileId, title, createdAt, updatedAt, outlineText, conclusions } = options;
  const vaultApi = getDesktopVaultApi();
  const { data: config } = useVaultConfig();
  const { t } = useTranslation();
  const labels = useMemo(
    () => ({
      outline: t("vault.section_outline"),
      summary: t("vault.section_summary"),
    }),
    [t],
  );

  useEffect(() => {
    if (!vaultApi || !config?.enabled || !fileId || !title) return;
    if (isLocalFileId(fileId)) return;
    if (!outlineText && conclusions.length === 0) return;
    const timer = setTimeout(() => {
      const payload = buildNoteMarkdown({
        fileId,
        title,
        createdAt,
        updatedAt,
        outlineText,
        conclusions,
        labels,
      });
      if (!payload) return;
      // The vault is a mirror; a failed write must never disturb the UI.
      vaultApi.writeNote(payload).catch(() => {});
    }, VAULT_WRITE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [vaultApi, config?.enabled, fileId, title, createdAt, updatedAt, outlineText, conclusions, labels]);
}

export interface VaultSyncNoteRef {
  id: string;
  title: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/**
 * Fetch outline + conclusions for every cloud note and assemble the markdown
 * payloads (frontmatter included). Shared by the local vault mirror and the
 * WebDAV notes push; fetching dominates the wall time, so progress is
 * reported per note fetched.
 */
export async function collectNotePayloads(
  notes: VaultSyncNoteRef[],
  labels?: Partial<VaultSectionLabels>,
  onProgress?: (progress: { done: number; total: number }) => void,
): Promise<VaultNotePayload[]> {
  const cloudNotes = notes.filter((note) => !isLocalFileId(note.id));
  const payloads: VaultNotePayload[] = [];
  let done = 0;
  for (const note of cloudNotes) {
    const [outline, conclusions] = await Promise.all([
      api()
        .getWithParams<FileOutline>("/api/business/file/outline/get", { fileId: note.id })
        .catch(() => null),
      api()
        .getWithParams<FileConclusion[]>("/api/business/file/conclusion/list", { fileId: note.id })
        .catch(() => [] as FileConclusion[]),
    ]);
    const payload = buildNoteMarkdown({
      fileId: note.id,
      title: note.title,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      outlineText: outline?.content ?? null,
      conclusions: (conclusions ?? []).map((conclusion, index) => ({
        id: String(conclusion.id ?? `summary-${index}`),
        name: conclusion.templateName ?? null,
        text: String(conclusion.conclusionText ?? ""),
      })),
      labels,
    });
    if (payload) payloads.push(payload);
    onProgress?.({ done: ++done, total: cloudNotes.length });
  }
  return payloads;
}

/**
 * Reuse existing vault files and fetch only missing notes. The disk writes additionally stream
 * `vault-sync-progress` events from the Rust side.
 */
export async function syncAllNotesToVault(
  notes: VaultSyncNoteRef[],
  labels?: Partial<VaultSectionLabels>,
  onProgress?: (progress: { done: number; total: number }) => void,
): Promise<VaultBatchSummary> {
  const vaultApi = getDesktopVaultApi();
  if (!vaultApi) throw new Error("Local vault bridge unavailable");

  const cloudNotes = notes.filter((note) => !isLocalFileId(note.id));
  const missing: VaultSyncNoteRef[] = [];
  let reused = 0;
  let written = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const note of cloudNotes) {
    try {
      const existing = await vaultApi.readNote(note.id);
      if (existing?.trim()) reused++;
      else missing.push(note);
    } catch (error) {
      failed++;
      errors.push(`${note.title}: ${String(error)}`);
    }
  }
  onProgress?.({ done: reused + failed, total: cloudNotes.length });
  const payloads = await collectNotePayloads(missing, labels, (progress) => onProgress?.({ done: reused + failed + progress.done, total: cloudNotes.length }));
  for (let start = 0; start < payloads.length; start += VAULT_SYNC_CHUNK_SIZE) {
    const summary = await vaultApi.writeNotes(payloads.slice(start, start + VAULT_SYNC_CHUNK_SIZE));
    written += summary.written;
    failed += summary.failed;
    errors.push(...summary.errors);
  }
  return { written, reused, failed, errors };
}

/** Fire-and-forget vault cleanup after a cloud-side note deletion. The Rust
 *  side no-ops while the vault is disabled, so the user's folder is never
 *  touched behind their back. */
export async function removeNotesFromVault(fileIds: string[]): Promise<void> {
  const vaultApi = getDesktopVaultApi();
  if (!vaultApi) return;
  await Promise.allSettled(fileIds.map((fileId) => vaultApi.removeNote(fileId)));
}

/** Timestamp of the last successful "sync all" run, for the settings card. */
export const VAULT_LAST_SYNC_KEY = "lynse_vault_last_sync";

export function markVaultLastSync(): void {
  try {
    localStorage.setItem(VAULT_LAST_SYNC_KEY, new Date().toISOString());
  } catch {
    /* localStorage unavailable */
  }
}

export function getVaultLastSync(): string | null {
  try {
    return localStorage.getItem(VAULT_LAST_SYNC_KEY);
  } catch {
    return null;
  }
}
