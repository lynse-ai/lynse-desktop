"use client";

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
import type { ChatConfirm } from "./types";

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

        <div className="flex flex-col gap-2">
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
        </div>

        <div className="flex justify-end">
          <DialogClose render={<Button variant="ghost" size="sm" />}>
            {t("chat.confirm_cancel")}
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
