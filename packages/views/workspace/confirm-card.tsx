"use client";

import { useState } from "react";
import { Check } from "../icons";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { useTranslation } from "@lynse/core/i18n/react";
import type { ChatConfirm, ChatConfirmPreviewValue } from "./types";

interface ConfirmCardProps {
  confirm: ChatConfirm;
  onSelect: (value: string) => void;
  onDismiss: () => void;
}

/**
 * Inline confirmation card, rendered inside the assistant's reply (Muse-style)
 * instead of a modal. While pending the options are clickable rows; once
 * answered (or dismissed) the card collapses in place — the chosen row keeps a
 * check mark, the rest dim out — so the transcript still shows what was asked
 * and picked.
 */
export function ConfirmCard({ confirm, onSelect, onDismiss }: ConfirmCardProps) {
  const { t } = useTranslation();
  const resolved = confirm.resolvedChoice !== undefined;
  const preview = !resolved && (confirm.kind?.startsWith("context_") || confirm.workbuddy)
    ? confirm.preview
    : undefined;
  const formatPreview = (value: ChatConfirmPreviewValue): string => {
    if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) return t("notifications.context_unspecified");
    if (typeof value === "boolean") return t(value ? "notifications.context_enabled" : "notifications.context_disabled");
    if (Array.isArray(value)) return value.map(formatPreview).join("\n");
    if (typeof value === "object") {
      if (typeof value.scope_type === "string") {
        const scope = ["global", "project", "person", "patient", "case"].includes(value.scope_type)
          ? t(`notifications.context_scope_${value.scope_type}`) : value.scope_type;
        return value.scope_id ? `${scope}：${String(value.scope_id)}` : scope;
      }
      if (typeof value.source_id === "string") return `${value.title || value.source_id} (${value.source_id})`;
      return Object.entries(value).map(([key, nested]) => `${key}：${formatPreview(nested)}`).join("\n");
    }
    return String(value);
  };

  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5">
      {confirm.question?.trim() && (
        <p className="text-sm font-medium leading-5 text-foreground">{confirm.question}</p>
      )}

      {preview && (
        <dl className="mt-2 max-h-[45vh] space-y-2 overflow-y-auto rounded-md border border-border bg-muted/30 p-3 text-sm">
          {Object.entries(preview).map(([label, value]) => (
            <div key={label}>
              <dt className="font-medium text-foreground">{label}</dt>
              <dd className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">{formatPreview(value)}</dd>
            </div>
          ))}
        </dl>
      )}

      {confirm.workbuddy?.questions?.length ? (
        !resolved ? (
          <WorkBuddyQuestions key={String(confirm.workbuddy.requestId)} confirm={confirm} onSelect={onSelect} />
        ) : (
          <ul className="mt-2 space-y-1.5">
            {summarizeAnswers(confirm).map((label, index) => (
              <li key={`${label}-${index}`} className="flex items-center gap-2 rounded-lg border border-primary bg-primary/5 px-3 py-2 text-sm text-foreground">
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <CheckCircle />
              </li>
            ))}
          </ul>
        )
      ) : (
        <div className="mt-2 flex flex-col gap-1.5">
          {confirm.options.map((opt, i) => {
            const chosen = confirm.resolvedChoice === opt.value;
            const dimmed = resolved && !chosen;
            return (
              <button
                key={`${opt.value}-${i}`}
                type="button"
                disabled={resolved}
                onClick={() => onSelect(opt.value)}
                className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  chosen
                    ? "border-primary bg-primary/5 font-medium text-foreground"
                    : dimmed
                      ? "border-dashed border-border text-muted-foreground"
                      : "border-border bg-background text-foreground hover:border-primary/40 hover:bg-accent"
                }`}
              >
                <span className="min-w-0 flex-1">{opt.label}</span>
                {chosen && <CheckCircle />}
              </button>
            );
          })}
        </div>
      )}

      {!resolved && (
        <button
          type="button"
          onClick={onDismiss}
          className="mt-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t("chat.confirm_cancel")}
        </button>
      )}
    </div>
  );
}

/** Filled check dot marking the chosen option, matching the selected row. */
function CheckCircle() {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary">
      <Check className="size-2.5 text-primary-foreground" strokeWidth={3} />
    </span>
  );
}

/**
 * Maps the submitted WorkBuddy answers JSON back to human-readable option
 * labels so the collapsed card shows what was answered, not raw values.
 */
function summarizeAnswers(confirm: ChatConfirm): string[] {
  const questions = confirm.workbuddy?.questions ?? [];
  try {
    const parsed = JSON.parse(confirm.resolvedChoice ?? "") as Record<string, string | string[]>;
    return questions.flatMap((question) => {
      const answer = parsed[question.id];
      const toLabel = (value: string) => question.options.find((option) => option.value === value)?.label ?? value;
      return Array.isArray(answer) ? answer.map(toLabel) : answer ? [toLabel(answer)] : [];
    });
  } catch {
    return [];
  }
}

function WorkBuddyQuestions({ confirm, onSelect }: { confirm: ChatConfirm; onSelect: (value: string) => void }) {
  const { t } = useTranslation();
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const questions = confirm.workbuddy?.questions ?? [];
  const complete = questions.every((question) => {
    const answer = answers[question.id];
    return !!custom[question.id]?.trim() || (question.multiSelect ? Array.isArray(answer) && answer.length > 0 : typeof answer === "string" && !!answer.trim());
  });
  return <form className="mt-2 space-y-4" onSubmit={(event) => {
    event.preventDefault();
    if (!complete) return;
    const result = Object.fromEntries(questions.map((question) => {
      const freeText = custom[question.id]?.trim();
      const answer = answers[question.id];
      return [question.id, question.multiSelect
        ? [...(Array.isArray(answer) ? answer : []), ...(freeText ? [freeText] : [])]
        : freeText || answer];
    }));
    onSelect(JSON.stringify(result));
  }}>
    {questions.map((question) => <fieldset key={question.id} className="space-y-2">
      <legend className="mb-2 text-sm font-medium">{question.question}</legend>
      {question.options.map((option) => <label key={option.value} className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-background p-2 text-sm">
        <input type={question.multiSelect ? "checkbox" : "radio"} name={question.id} className="mt-0.5 accent-primary"
          checked={question.multiSelect ? Array.isArray(answers[question.id]) && answers[question.id]!.includes(option.value) : answers[question.id] === option.value && !custom[question.id]}
          onChange={(event) => {
            if (!question.multiSelect) setCustom((previous) => ({ ...previous, [question.id]: "" }));
            setAnswers((previous) => {
              const current = Array.isArray(previous[question.id]) ? previous[question.id] as string[] : [];
              return { ...previous, [question.id]: question.multiSelect
                ? event.target.checked ? [...current, option.value] : current.filter((value) => value !== option.value)
                : option.value };
            });
          }} />
        <span>{option.label}</span>
      </label>)}
      <Input aria-label={`${question.question} ${t("workbuddy.cloud_answer_placeholder")}`} placeholder={t("workbuddy.cloud_answer_placeholder")}
        value={custom[question.id] ?? ""} onChange={(event) => setCustom((previous) => ({ ...previous, [question.id]: event.target.value }))} />
    </fieldset>)}
    <Button type="submit" disabled={!complete} className="w-full">{t("workbuddy.cloud_submit")}</Button>
  </form>;
}
