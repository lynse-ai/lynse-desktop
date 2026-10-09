"use client";

import { useState } from "react";
import { Input } from "@lynse/ui/components/ui/input";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@lynse/ui/components/ui/dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { useTranslation } from "@lynse/core/i18n/react";
import type { ChatConfirm, ChatConfirmPreviewValue } from "./types";

interface ConfirmDialogProps {
  confirm: ChatConfirm | null;
  onSelect: (value: string) => void;
  onDismiss: () => void;
}

/**
 * Codex-style confirmation dialog. When the assistant requests confirmation
 * (via the a2UI `confirm` event, or auto-detected from an A/B/C option list),
 * this pops a modal with clickable options instead of forcing the user to
 * type "A"/"B"/"C".
 */
export function ConfirmDialog({ confirm, onSelect, onDismiss }: ConfirmDialogProps) {
  const { t } = useTranslation();
  const open = !!confirm;
  const preview = confirm?.kind?.startsWith("context_") || confirm?.workbuddy ? confirm?.preview : undefined;
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
    <Dialog open={open} onOpenChange={(next) => {
      if (!next) onDismiss();
    }}>
      <DialogContent className="max-w-sm" showCloseButton>
        <DialogHeader>
          <DialogTitle>{t("chat.confirm_title")}</DialogTitle>
          <DialogDescription>
            {confirm?.question?.trim() ? confirm.question : t("chat.confirm_default_question")}
          </DialogDescription>
        </DialogHeader>

        {preview && (
          <dl className="max-h-[45vh] space-y-2 overflow-y-auto rounded-md border border-border bg-muted/30 p-3 text-sm">
            {Object.entries(preview).map(([label, value]) => (
              <div key={label}>
                <dt className="font-medium text-foreground">{label}</dt>
                <dd className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">{formatPreview(value)}</dd>
              </div>
            ))}
          </dl>
        )}

        {confirm?.workbuddy?.questions?.length ? (
          <WorkBuddyQuestions key={String(confirm.workbuddy.requestId)} confirm={confirm} onSelect={onSelect} />
        ) : <div className="flex flex-col gap-2">
          {confirm?.options.map((opt, i) => (
            <Button
              key={`${opt.value}-${i}`}
              variant="outline"
              className="h-auto justify-start whitespace-normal py-2.5 text-left text-sm"
              onClick={() => onSelect(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>}

        <div className="flex justify-end">
          <DialogClose render={<Button variant="ghost" size="sm" />}>
            {t("chat.confirm_cancel")}
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
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
  return <form className="max-h-[55vh] space-y-4 overflow-y-auto" onSubmit={(event) => {
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
      {question.options.map((option) => <label key={option.value} className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-sm">
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
