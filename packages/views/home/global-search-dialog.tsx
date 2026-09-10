"use client";

/**
 * Global search (全局搜索) — a ⌘K command palette over everything the client
 * already has or can cheaply load: journal entries (text + transcript),
 * todos (titles), and notes/recordings (titles). Purely client-side — no
 * backend search endpoint involved; note content search is out of scope
 * until a server-side index exists. Selecting a result jumps to its module,
 * exactly like the home feed rows.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@lynse/ui/components/ui/command";
import { useNavigation } from "../navigation";
import { getWorkspaceState } from "../workspace/store";
import { getDesktopLocalTranscriptionApi } from "../workspace/local-transcription";
import { useNotes } from "../workspace/hooks/use-files";
import type { WorkspaceItem } from "../workspace/types";
import { useTodos } from "../todo/use-todos";
import type { TodoItem } from "../todo/todo-api";
import { getDesktopInspirationApi } from "../inspiration";
import type { InspirationRecord } from "../inspiration/types";
import { FileText, ListChecks, Zap } from "../icons";

/** Results shown per group, so one noisy group can't drown the others. */
const MAX_PER_GROUP = 5;

export function GlobalSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { push } = useNavigation();
  const [query, setQuery] = useState("");
  const notesPath = getDesktopLocalTranscriptionApi() ? "/notes" : "/recordings";
  const todoPageAvailable = notesPath === "/notes";

  // Read-through of the app's existing data sources; queries are keyed the
  // same as their owning pages, so an open palette mostly rides warm caches.
  const notes = useNotes({ enabled: open });
  const todos = useTodos();
  const inspirationApi = getDesktopInspirationApi();
  const inspirations = useQuery({
    queryKey: ["inspirations"],
    queryFn: () => inspirationApi!.list(),
    enabled: Boolean(inspirationApi) && open,
  });

  // A fresh query each time the palette opens.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const q = query.trim().toLowerCase();

  const matchedJournals = useMemo(
    () =>
      q
        ? (inspirations.data ?? [])
            .filter((record) =>
              `${record.text} ${record.transcript ?? ""}`.toLowerCase().includes(q),
            )
            .slice(0, MAX_PER_GROUP)
        : [],
    [inspirations.data, q],
  );

  const matchedTodos = useMemo(
    () =>
      q
        ? todos.todos
            .filter((todo) => !todo.completed && todo.title.toLowerCase().includes(q))
            .slice(0, MAX_PER_GROUP)
        : [],
    [todos.todos, q],
  );

  const matchedNotes = useMemo(
    () =>
      q
        ? (notes.data ?? [])
            .filter((item) => item.title.toLowerCase().includes(q))
            .slice(0, MAX_PER_GROUP)
        : [],
    [notes.data, q],
  );

  const hasResults =
    matchedJournals.length > 0 || matchedTodos.length > 0 || matchedNotes.length > 0;

  const close = () => onOpenChange(false);
  const openNote = (item: WorkspaceItem) => {
    getWorkspaceState().selectItem(item.id, "file", item.title);
    push(notesPath);
    close();
  };
  const openTodo = (_todo: TodoItem) => {
    push("/todo");
    close();
  };
  const openJournal = (_record: InspirationRecord) => {
    push("/inspiration");
    close();
  };

  const journalLabel = (record: InspirationRecord): string =>
    record.text.split("\n")[0]?.trim() ||
    record.transcript?.trim() ||
    t("inspiration.title");

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("home.search_records")}
      description={t("home.search_records")}
    >
      <Command shouldFilter={false}>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={t("home.search_placeholder")}
        />
        <CommandList className="max-h-80">
          {!q ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t("home.search_hint")}
            </p>
          ) : !hasResults ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t("home.search_empty")}
            </p>
          ) : (
            <>
              {matchedJournals.length > 0 && (
                <CommandGroup heading={t("home.type_flash")}>
                  {matchedJournals.map((record) => (
                    <CommandItem
                      key={record.id}
                      value={`journal-${record.id}`}
                      onSelect={() => openJournal(record)}
                    >
                      <Zap className="text-primary" />
                      <span className="truncate">{journalLabel(record)}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {matchedTodos.length > 0 && (
                <CommandGroup heading={t("home.type_todo")}>
                  {matchedTodos.map((todo) => (
                    <CommandItem
                      key={todo.id}
                      value={`todo-${todo.id}`}
                      disabled={!todoPageAvailable}
                      onSelect={() => openTodo(todo)}
                    >
                      <ListChecks className="text-primary" />
                      <span className="truncate">{todo.title}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {matchedNotes.length > 0 && (
                <CommandGroup heading={t("home.type_note")}>
                  {matchedNotes.map((item) => (
                    <CommandItem
                      key={item.id}
                      value={`note-${item.id}`}
                      onSelect={() => openNote(item)}
                    >
                      <FileText className="text-primary" />
                      <span className="truncate">{item.title}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
