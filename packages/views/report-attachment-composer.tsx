"use client";

/**
 * Composer for the report/feedback forms: the description box with the
 * attachments living inside it, chat-composer style, so the dialogs stay
 * compact by default. The toolbar row carries the paperclip upload button
 * (stages a user-picked image through the host), the screenshot capture /
 * retake button, and the include-logs checkbox (default on). Existing
 * attachments render as a small thumbnail chip; clicking it still opens the
 * full-size annotation editor.
 */

import { Button } from "@lynse/ui/components/ui/button";
import { Checkbox } from "@lynse/ui/components/ui/checkbox";
import { Textarea } from "@lynse/ui/components/ui/textarea";
import { cn } from "@lynse/ui/lib/utils";
import { useTranslation } from "@lynse/core/i18n/react";
import { Loader2, Paperclip, Scan, X } from "./icons";
import type { StagedScreenshot } from "./diagnostics";

export function ReportAttachmentComposer({
  id,
  value,
  onChange,
  placeholder,
  autoFocus,
  screenshot,
  previewFailed,
  capturing,
  canAnnotate,
  canPick,
  canCapture,
  showLogToggle,
  includeLogs,
  onIncludeLogsChange,
  onOpenEditor,
  onCapture,
  onPick,
  onRemove,
  onPreviewError,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  screenshot: StagedScreenshot | null;
  previewFailed: boolean;
  capturing: boolean;
  /** Host without the annotation command: the thumbnail stays inert. */
  canAnnotate: boolean;
  /** Host without the attachment staging command: no upload button. */
  canPick: boolean;
  /** Host without the capture command: the capture button stays disabled. */
  canCapture: boolean;
  /** Whether app logs were read and can ride along (hides the toggle otherwise). */
  showLogToggle: boolean;
  includeLogs: boolean;
  onIncludeLogsChange: (include: boolean) => void;
  onOpenEditor: () => void;
  onCapture: () => void;
  onPick: () => void;
  onRemove: () => void;
  onPreviewError: () => void;
}) {
  const { t } = useTranslation();
  const thumbClickable = canAnnotate && !capturing;
  const showThumbnail = Boolean(screenshot) && !previewFailed;
  return (
    <div className="overflow-hidden rounded-md border">
      <Textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="min-h-24 rounded-none border-0 bg-transparent px-2.5 py-2 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
      />
      {(showThumbnail || previewFailed) && (
        <div className="flex flex-wrap items-center gap-2 px-2.5 pb-1.5">
          {showThumbnail ? (
            <div className="group relative shrink-0">
              <button
                type="button"
                onClick={thumbClickable ? onOpenEditor : undefined}
                disabled={capturing}
                className={cn(
                  "block h-14 w-24 overflow-hidden rounded-md border bg-muted/30 transition-opacity",
                  thumbClickable && "cursor-zoom-in hover:opacity-90",
                )}
              >
                <img
                  src={screenshot!.url}
                  alt={t("settings.report_screenshot_label")}
                  decoding="async"
                  onError={onPreviewError}
                  className="size-full object-cover"
                />
              </button>
              <button
                type="button"
                onClick={onRemove}
                aria-label={t("settings.report_remove")}
                className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border bg-background text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-2.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onCapture}
              disabled={capturing}
              className="flex h-7 max-w-full items-center gap-1.5 rounded-md border border-dashed px-2 text-2xs text-muted-foreground transition-colors hover:bg-muted/30 disabled:opacity-60"
            >
              <Paperclip className="size-3 shrink-0" />
              <span className="truncate">{t("settings.report_preview_failed")}</span>
            </button>
          )}
          {canAnnotate && showThumbnail && (
            <p className="min-w-0 flex-1 text-2xs leading-relaxed text-muted-foreground">
              {t("settings.report_annotate_hint")}
            </p>
          )}
        </div>
      )}
      <div className="flex items-center gap-1 border-t px-1.5 py-1.5">
        {canPick && (
          <button
            type="button"
            onClick={onPick}
            disabled={capturing}
            className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-60"
          >
            <Paperclip className="size-3.5" />
            {t("settings.report_attach_upload")}
          </button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
          disabled={capturing || !canCapture}
          onClick={onCapture}
        >
          {capturing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Scan className="size-3.5" />
          )}
          {screenshot ? t("settings.report_retake") : t("settings.report_screenshot_label")}
        </Button>
        <div className="min-w-2 flex-1" />
        {showLogToggle && (
          <label className="flex shrink-0 cursor-pointer items-center gap-1.5 pr-1.5 text-2xs text-muted-foreground">
            <Checkbox
              checked={includeLogs}
              onCheckedChange={(checked) => onIncludeLogsChange(checked === true)}
              className="size-3.5"
            />
            {t("settings.report_submit_logs")}
          </label>
        )}
      </div>
    </div>
  );
}
