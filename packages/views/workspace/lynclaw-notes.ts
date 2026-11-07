import { useQuery } from "@tanstack/react-query";
import { api } from "@lynse/core/api/client";
import { getAuthStore, useAuthStore } from "@lynse/core/auth";
import type { LynclawSummaryFormat } from "./lynclaw-summary";

export const LYNCLAW_NOTE_TITLE = "lynclaw总结";
export const LYNCLAW_FORMAT_LABELS = { markdown: "Markdown", html: "HTML" } as const;
const LYNCLAW_NOTE_PREFIX = "lynclaw-note:";

export interface LynclawNoteInfo {
  id: string;
  title: string;
  sourceFileId: string;
  sourceTitle: string;
  format: LynclawSummaryFormat;
  createdAt: string;
}

export interface LynclawNote extends LynclawNoteInfo {
  body: string;
}

export interface DesktopLynclawNotesApi {
  list(scope: string): Promise<LynclawNoteInfo[]>;
  create(scope: string, note: Pick<LynclawNote, "title" | "sourceFileId" | "sourceTitle" | "format" | "body">): Promise<LynclawNoteInfo>;
  read(scope: string, id: string): Promise<LynclawNote | null>;
  update(scope: string, id: string, body: string): Promise<void>;
  delete(scope: string, id: string): Promise<void>;
}

export function getDesktopLynclawNotesApi(): DesktopLynclawNotesApi | undefined {
  if (typeof window === "undefined") return;
  return (window as Window & { desktopAPI?: { lynclawNotes?: DesktopLynclawNotesApi } }).desktopAPI?.lynclawNotes;
}

function noteScope(userId: string | undefined): string | null {
  if (!userId || !getDesktopLynclawNotesApi()) return null;
  return JSON.stringify([api().getBaseUrl().replace(/\/+$/, ""), userId]);
}

export function getLynclawNotesScope(): string | null {
  const auth = getAuthStore()?.getState();
  return noteScope(auth?.isAuthenticated ? auth.user?.id : undefined);
}

export function useLynclawNotesScope(): string | null {
  return noteScope(useAuthStore((state) => state.isAuthenticated ? state.user?.id : undefined));
}

export function lynclawNoteItemId(id: string): string {
  return LYNCLAW_NOTE_PREFIX + id;
}

export function lynclawNoteId(itemId: string | null): string | null {
  return itemId?.startsWith(LYNCLAW_NOTE_PREFIX) ? itemId.slice(LYNCLAW_NOTE_PREFIX.length) : null;
}

export function lynclawNotesKey(scope: string | null) {
  return ["lynclaw-notes", scope] as const;
}

export function lynclawNoteKey(scope: string, id: string) {
  return ["lynclaw-note", scope, id] as const;
}

export function useLynclawNotes(scope: string | null) {
  const bridge = getDesktopLynclawNotesApi();
  return useQuery({
    queryKey: lynclawNotesKey(scope),
    queryFn: () => bridge!.list(scope!),
    enabled: !!scope && !!bridge,
  });
}

/** Best-effort cleanup: delete lynclaw notes whose source file was deleted.
 *  The standalone-note era had no cascade, so orphans would resurface in the
 *  notes list forever without this sweep. */
export async function deleteLynclawNotesForSources(fileIds: readonly string[]): Promise<void> {
  const bridge = getDesktopLynclawNotesApi();
  const scope = getLynclawNotesScope();
  if (!bridge || !scope || fileIds.length === 0) return;
  const notes = await bridge.list(scope).catch(() => []);
  const stale = notes.filter((note) => fileIds.includes(note.sourceFileId));
  await Promise.allSettled(stale.map((note) => bridge.delete(scope, note.id)));
}
