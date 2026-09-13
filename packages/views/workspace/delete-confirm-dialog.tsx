"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@lynse/ui/components/ui/dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { useTranslation } from "@lynse/core/i18n/react";
import { Loader2 } from "../icons";

interface DeleteConfirmDialogProps {
  open: boolean;
  description: string;
  /** Disables the buttons and shows a spinner on the confirm button. */
  pending?: boolean;
  /** Confirm-button label; defaults to the generic "Delete". */
  confirmLabel?: string;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

/**
 * Styled replacement for `window.confirm` on destructive actions: a themed
 * modal with an explicit destructive button (and pending state) instead of a
 * blocking native dialog.
 */
export function DeleteConfirmDialog({
  open,
  description,
  pending,
  confirmLabel,
  onConfirm,
  onOpenChange,
}: DeleteConfirmDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t("workspace.delete_confirm_title")}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("workspace.cancel")}
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} disabled={pending}>
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            {confirmLabel ?? t("workspace.delete")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
