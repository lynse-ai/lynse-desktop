"use client";

/**
 * "Share note" entry for the note header's overflow menu. This is only the
 * trigger: the <ShareNoteDialog> must render OUTSIDE the DropdownMenuContent
 * tree (it lives at panel level, next to ResummarizeDialog), because closing
 * the menu unmounts the menu content subtree — a dialog mounted inside it
 * would flash and vanish with the menu.
 */
import { DropdownMenuItem } from "@lynse/ui/components/ui/dropdown-menu";
import { useTranslation } from "@lynse/core/i18n/react";
import { Share } from "../../icons";

export function ShareNoteMenuItem({
  onOpen,
  disabled,
}: {
  /** Opens the panel-level ShareNoteDialog. */
  onOpen: () => void;
  /** Note is still summarizing, or has no content to share yet. */
  disabled?: boolean;
}) {
  const { t } = useTranslation();

  return (
    <DropdownMenuItem
      disabled={disabled}
      onClick={(event) => {
        event.preventDefault();
        onOpen();
      }}
    >
      <Share className="size-3.5 text-muted-foreground" strokeWidth={1.5} />
      <span>{t("share.menu")}</span>
    </DropdownMenuItem>
  );
}
