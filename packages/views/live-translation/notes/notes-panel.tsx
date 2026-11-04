"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, CircleDot, Fish, ListTodo, NotebookPen, ScrollText, Tag } from "../../icons";
import type { NoteItem, NoteTerm, NoteTopic } from "@lynse/core/api";
import { FishboneDiagram } from "./fishbone-diagram";
import type { LiveNotesState } from "./engine";
import { useTranslation } from "@lynse/core/i18n/react";

/** Structured live notes panel: summary + topics (expandable fishbone) +
 *  conclusions + todos + terms. Renders the engine's latest revision; the
 *  status line explains what the engine is doing and degrades quietly on
 *  errors (the previous revision always stays visible). */

export function LiveNotesPanel({ state }: { state: LiveNotesState }) {
  const { t } = useTranslation();
  const notes = state.notes;

  if (!notes) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
        <NotebookPen className="size-6 opacity-50" />
        <p className="text-xs leading-relaxed">
          {state.status === "error"
            ? t("live_translation.notes_error")
            : state.status === "finalizing"
              ? t("live_translation.notes_finalizing")
              : t("live_translation.notes_waiting")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <StatusLine state={state} />
      {notes.title && <h3 className="mb-1 text-sm font-semibold text-foreground">{notes.title}</h3>}
      {notes.summary && <p className="mb-4 text-xs leading-relaxed text-muted-foreground">{notes.summary}</p>}

      {notes.topics.length > 0 && (
        <Section icon={<ScrollText className="size-3.5" />} label={t("live_translation.notes_topics")}>
          <div className="space-y-2">
            {notes.topics.map((topic, index) => (
              <TopicCard key={`${topic.start_line_id}-${index}`} topic={topic} state={state} />
            ))}
          </div>
        </Section>
      )}

      {notes.conclusions.length > 0 && (
        <Section icon={<CircleDot className="size-3.5" />} label={t("live_translation.notes_conclusions")}>
          <ul className="space-y-1.5">
            {notes.conclusions.map((item, index) => (
              <ItemRow key={index} item={item} />
            ))}
          </ul>
        </Section>
      )}

      {notes.todos.length > 0 && (
        <Section icon={<ListTodo className="size-3.5" />} label={t("live_translation.notes_todos")}>
          <ul className="space-y-1.5">
            {notes.todos.map((item, index) => (
              <ItemRow key={index} item={item} />
            ))}
          </ul>
        </Section>
      )}

      {notes.terms.length > 0 && (
        <Section icon={<Tag className="size-3.5" />} label={t("live_translation.notes_terms")}>
          <div className="flex flex-wrap gap-1.5">
            {notes.terms.map((term, index) => (
              <TermChip key={index} term={term} />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function StatusLine({ state }: { state: LiveNotesState }) {
  const { t } = useTranslation();
  if (state.status === "waiting") return null;
  const label =
    state.status === "updating"
      ? t("live_translation.notes_updating")
      : state.status === "finalizing"
        ? t("live_translation.notes_finalizing")
        : state.status === "error"
          ? t("live_translation.notes_error")
          : null;
  if (!label) return null;
  const busy = state.status === "updating" || state.status === "finalizing";
  return (
    <div className="mb-3 flex items-center gap-1.5 text-2xs text-muted-foreground">
      {busy && <span className="size-1.5 animate-pulse rounded-full bg-primary" />}
      <span>{label}</span>
    </div>
  );
}

function Section({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <section className="mb-4">
      <h4 className="mb-1.5 flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </h4>
      {children}
    </section>
  );
}

function FreshBadge({ fresh }: { fresh: boolean }) {
  const { t } = useTranslation();
  if (!fresh) return null;
  return (
    <span className="rounded-sm bg-primary/15 px-1 py-px text-2xs font-medium text-primary">
      {t("live_translation.notes_fresh")}
    </span>
  );
}

function TopicCard({ topic, state }: { topic: NoteTopic; state: LiveNotesState }) {
  const { t } = useTranslation();
  const [fishboneOpen, setFishboneOpen] = useState(false);
  const fresh = state.freshTopicIds.includes(`${topic.start_line_id}::${topic.title}`);
  return (
    <div className="rounded-lg border border-border bg-background/60 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-2xs tabular-nums text-muted-foreground/70">{formatMs(topic.start_ms)}</span>
            <span className="truncate text-xs font-semibold text-foreground">{topic.title}</span>
          </div>
          {topic.summary && <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">{topic.summary}</p>}
        </div>
        <FreshBadge fresh={fresh} />
      </div>
      {topic.points.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {topic.points.map((point, index) => (
            <li key={index} className="flex items-start gap-1.5 text-2xs leading-relaxed text-foreground/90">
              <span
                className={`mt-1 size-1.5 shrink-0 rounded-full ${point.support === 0 ? "bg-muted-foreground/40" : "bg-primary/60"}`}
                title={point.support === 0 ? t("live_translation.notes_weak_evidence") : undefined}
              />
              <span className="min-w-0">{point.text}</span>
            </li>
          ))}
        </ul>
      )}
      {topic.fishbone && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setFishboneOpen((open) => !open)}
            className="flex items-center gap-1 text-2xs font-medium text-primary transition-colors hover:text-primary/80"
          >
            <Fish className="size-3" />
            {fishboneOpen ? t("live_translation.notes_fishbone_hide") : t("live_translation.notes_fishbone_show")}
            {fishboneOpen ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
          </button>
          {fishboneOpen && (
            <div className="mt-2 rounded-md border border-border/60 bg-muted/20 p-2 text-foreground/80">
              <FishboneDiagram fishbone={topic.fishbone} />
              <ul className="mt-1 space-y-1">
                {topic.fishbone.branches.map((branch, index) => (
                  <li key={index} className="text-2xs leading-relaxed">
                    <span className="font-medium text-foreground">{branch.label}</span>
                    {branch.detail && <span className="text-muted-foreground">：{branch.detail}</span>}
                    {branch.support === 0 && (
                      <span className="ml-1 text-muted-foreground/60">({t("live_translation.notes_weak_evidence")})</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ItemRow({ item }: { item: NoteItem }) {
  return (
    <li className="flex items-start gap-1.5 text-2xs leading-relaxed text-foreground/90">
      <span
        className={`mt-1 size-1.5 shrink-0 rounded-full ${item.support === 0 ? "bg-muted-foreground/40" : "bg-primary/60"}`}
      />
      <span className="min-w-0">
        {item.text}
        {item.owner && <span className="text-muted-foreground"> · {item.owner}</span>}
      </span>
    </li>
  );
}

function TermChip({ term }: { term: NoteTerm }) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-2xs"
      title={term.note || term.name}
    >
      <span className="truncate font-medium text-foreground">{term.name}</span>
      {term.note && <span className="truncate text-muted-foreground">{term.note}</span>}
    </span>
  );
}

function formatMs(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "--:--";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
