"use client";

import { useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { Checkbox } from "@lynse/ui/components/ui/checkbox";
import type { CompletedLiveSession } from "./types";

// ───────────────────────────────────────────────────────────────
// Recording Complete Dialog
//
// Modal shown after a recording session stops. Presents the user
// with duration / filename info and offers "save locally" or
// "dismiss" actions. Includes a "remember my choice" checkbox
// that skips this dialog on future stops.
// ───────────────────────────────────────────────────────────────

interface RecordingCompleteDialogProps {
  /** The completed session data returned by `api.stop()`. */
  readonly completedSession: CompletedLiveSession | null;
  /** Whether the dialog is currently open. */
  readonly open: boolean;
  /** Called when the dialog should close (user dismisses or acts). */
  readonly onOpenChange: (open: boolean) => void;
  /** Called when the user taps "保存到本地". */
  readonly onSave?: (session: CompletedLiveSession) => void;
  /** Called when the user taps "不需要". */
  readonly onDismiss?: () => void;
  /** Called when the "remember choice" checkbox value changes. */
  readonly onRememberChoiceChange?: (remember: boolean) => void;
}

/** Format ms into a human-readable short string like "27秒" or "1分30秒". */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}秒`;
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return ss > 0 ? `${mm}分${ss}秒` : `${mm}分`;
}

/** Derive a display filename from the completed session. */
export function deriveFilename(session: CompletedLiveSession): string {
  // Use playbackPath basename or fall back to a timestamp-based name.
  if (session.playbackPath) {
    const parts = session.playbackPath.split(/[/\\]/);
    const last = parts[parts.length - 1];
    if (last && /\./.test(last)) return last;
  }
  const d = new Date();
  const ts = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    "_",
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
  ].join("");
  return `${ts}_Recording.wav`;
}

export function RecordingCompleteDialog({
  completedSession,
  open,
  onOpenChange,
  onSave,
  onDismiss,
  onRememberChoiceChange,
}: RecordingCompleteDialogProps) {
  const { t } = useTranslation();
  const [remember, setRemember] = useState(false);

  if (!completedSession || !open) return null;

  // Narrow for closures — TS doesn't track early-return narrowing into handlers.
  const session = completedSession;
  const filename = deriveFilename(session);

  function handleSave() {
    onSave?.(session);
    onOpenChange(false);
  }

  function handleDismiss() {
    onDismiss?.();
    onOpenChange(false);
  }

  function handleRememberChange(checked: boolean | "indeterminate") {
    const val = checked === true;
    setRemember(val);
    onRememberChoiceChange?.(val);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md gap-0 overflow-hidden p-0"
      >
        {/* ═══ Body ═══ */}
        <div className="flex flex-col gap-4 px-6 pt-6 pb-2">
          {/* Title */}
          <DialogTitle className="text-lg font-semibold leading-tight">
            {t("recording_mode.complete_title")}
          </DialogTitle>

          {/* Info card */}
          <div className="rounded-xl bg-muted/60 px-4 py-3">
            <div className="flex items-center justify-between gap-4 text-[13px]">
              <span className="text-muted-foreground">{t("recording_mode.complete_duration")}</span>
              <span className="font-medium tabular-nums">{formatDuration(session.durationMs)}</span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-4 text-[13px]">
              <span className="text-muted-foreground">{t("recording_mode.complete_filename")}</span>
              <span className="truncate font-mono text-xs text-foreground/80 max-w-[55%]">{filename}</span>
            </div>
          </div>

          {/* Description */}
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t("recording_mode.complete_description")}
          </p>

          {/* Remember choice checkbox */}
          <label className="flex cursor-pointer items-center gap-2.5 self-center pb-1">
            <Checkbox
              checked={remember}
              onCheckedChange={handleRememberChange}
            />
            <span className="text-[13px] text-muted-foreground select-none">
              {t("recording_mode.complete_remember")}
            </span>
          </label>
        </div>

        {/* ═══ Footer buttons ═══ */}
        <div className="flex items-center justify-end gap-3 border-t border-border/60 bg-background px-6 py-4">
          <Button
            variant="outline"
            onClick={handleDismiss}
            className="min-w-[80px]"
          >
            {t("recording_mode.complete_dismiss")}
          </Button>
          <Button
            onClick={handleSave}
            className="min-w-[120px] bg-foreground text-background hover:bg-foreground/90"
          >
            {t("recording_mode.complete_save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
