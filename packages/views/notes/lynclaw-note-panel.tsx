"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { toast } from "sonner";
import { FileText, Trash2 } from "../icons";
import { SourceView } from "../workspace/content-panel";
import { DeleteConfirmDialog } from "../workspace/delete-confirm-dialog";
import {
  getDesktopLynclawNotesApi,
  LYNCLAW_FORMAT_LABELS,
  lynclawNoteItemId,
  lynclawNoteKey,
  lynclawNotesKey,
  type LynclawNote,
  type LynclawNoteInfo,
} from "../workspace/lynclaw-notes";
import { getWorkspaceState, useWorkspaceStore } from "../workspace/store";
import { SummaryMarkdownEditor } from "../workspace/summary-editor";

export function LynclawNoteRow({ note, selected, onOpen }: {
  note: LynclawNoteInfo;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? "true" : undefined}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-start transition-colors ${selected ? "bg-accent" : "hover:bg-accent/50"}`}
    >
      <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-foreground">{note.title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {[note.sourceTitle, LYNCLAW_FORMAT_LABELS[note.format]].filter(Boolean).join(" · ")}
        </span>
      </span>
    </button>
  );
}

export function LynclawNotePanel({ scope, id }: { scope: string; id: string }) {
  const { t } = useTranslation();
  const { data: note, isPending, refetch } = useQuery({
    queryKey: lynclawNoteKey(scope, id),
    queryFn: () => getDesktopLynclawNotesApi()!.read(scope, id),
  });
  if (!note) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        {t(isPending ? "workspace.loading" : "workspace.lynclaw_note_load_failed")}
        {!isPending && (
          <Button variant="ghost" size="sm" onClick={() => void refetch()}>{t("workspace.retry")}</Button>
        )}
      </div>
    );
  }
  return <LynclawNoteDocument note={note} scope={scope} />;
}

function LynclawNoteDocument({ note, scope }: { note: LynclawNote; scope: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const sourceViewVisible = useWorkspaceStore((s) => s.sourceViewVisible);
  const [body, setBody] = useState(note.body);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pendingSave = useRef<{ body: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const key = lynclawNoteKey(scope, note.id);
  const mutationScope = { id: lynclawNoteItemId(note.id) };

  const { mutate: saveBody } = useMutation({
    scope: mutationScope,
    mutationFn: (markdown: string) => getDesktopLynclawNotesApi()!.update(scope, note.id, markdown),
    onSuccess: (_, markdown) => qc.setQueryData<LynclawNote>(key, (saved) => saved ? { ...saved, body: markdown } : saved),
    onError: () => toast.error(t("workspace.lynclaw_note_save_failed")),
  });
  const flushEdit = useCallback(() => {
    if (!pendingSave.current) return;
    const { body: markdown, timer } = pendingSave.current;
    clearTimeout(timer);
    pendingSave.current = null;
    saveBody(markdown);
  }, [saveBody]);
  useEffect(() => flushEdit, [flushEdit]);

  const onChange = (markdown: string) => {
    setBody(markdown);
    if (pendingSave.current) clearTimeout(pendingSave.current.timer);
    pendingSave.current = { body: markdown, timer: setTimeout(flushEdit, 500) };
  };

  const remove = useMutation({
    scope: mutationScope,
    mutationFn: () => getDesktopLynclawNotesApi()!.delete(scope, note.id),
    onSuccess: () => {
      const listKey = lynclawNotesKey(scope);
      void qc.cancelQueries({ queryKey: listKey, exact: true });
      qc.setQueryData<LynclawNoteInfo[]>(listKey, (rows) => rows?.filter((row) => row.id !== note.id));
      void qc.invalidateQueries({ queryKey: listKey, exact: true });
      const state = getWorkspaceState();
      if (state.selectedItemId === lynclawNoteItemId(note.id)) state.selectItem(null, null);
      qc.removeQueries({ queryKey: key, exact: true });
    },
    onError: (error) => toast.error(t("workspace.delete_failed", { error: error.message })),
  });

  return (
    <article className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-start justify-between gap-2 border-b border-border/50 px-4 py-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold leading-tight text-foreground">{note.title}</h1>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {[note.sourceTitle, LYNCLAW_FORMAT_LABELS[note.format]].filter(Boolean).join(" · ")}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("workspace.delete")}
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="size-4" />
        </Button>
      </header>
      {sourceViewVisible ? (
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          <SourceView code={body} language={note.format} />
        </div>
      ) : note.format === "html" ? (
        <iframe className="min-h-0 w-full flex-1 border-0" title={note.title} srcDoc={body} sandbox="" />
      ) : (
        <div className="content-preview min-h-0 flex-1 overflow-auto px-4 py-5">
          <SummaryMarkdownEditor content={body} onChange={onChange} />
        </div>
      )}
      <DeleteConfirmDialog
        open={confirmDelete}
        pending={remove.isPending}
        description={t("workspace.lynclaw_note_delete_confirm")}
        onOpenChange={setConfirmDelete}
        onConfirm={() => { flushEdit(); remove.mutate(); }}
      />
    </article>
  );
}
