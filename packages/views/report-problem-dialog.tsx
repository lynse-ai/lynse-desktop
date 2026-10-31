"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Dialog,
  DialogContent,
} from "@lynse/ui/components/ui/dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { Textarea } from "@lynse/ui/components/ui/textarea";
import { useTranslation } from "@lynse/core/i18n/react";
import { Camera, Check, Loader2, RefreshCw, X } from "./icons";
import { initI18n } from "@lynse/core/i18n";
import { getAppInfoSync } from "./app-update";
import {
  buildIssueUrl,
  getDesktopDiagnosticsApi,
  getReportChannel,
  showScreenshotCaptureError,
  takePendingScreenshot,
  takePendingReportDescription,
  useReportProblemDialog,
  type LogTail,
  type StagedScreenshot,
} from "./diagnostics";
import { RESOURCES } from "./locales";
import { isTauri } from "./layout/use-maximized";

type Phase = "compose" | "submitting" | "submitted";
type Submitted = { number: number };

/** Open a URL in the system browser, falling back to window.open on web. */
function openInBrowser(url: string): void {
  const desktopWindow = window as Window & {
    desktopAPI?: { openExternal?: (url: string) => Promise<void> };
  };
  if (desktopWindow.desktopAPI?.openExternal) {
    void desktopWindow.desktopAPI.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

function clampText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `…[截断 / truncated]…\n${text.slice(-limit)}`;
}

/** Markdown body for the CNB issue: description + environment + log tail. */
function composeIssueBody(input: { description: string; logTail: LogTail | null }): string {
  const appInfo = getAppInfoSync();
  const lines = [
    "## 问题描述 / What happened",
    input.description.trim(),
    "",
    "## 环境 / Environment",
    `- App: v${appInfo?.version ?? "unknown"}`,
    `- Platform: ${appInfo?.platform ?? "unknown"}`,
    `- User agent: ${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}`,
    `- Date: ${new Date().toISOString()}`,
  ];
  if (input.logTail?.tail) {
    lines.push("", "## 日志（尾部）/ Logs (tail)", "```text", clampText(input.logTail.tail, 6000), "```");
  }
  return lines.join("\n");
}

/**
 * The problem report surface, shared by its two faces: the standalone
 * report window (macOS) and the in-app dialog (Windows/web fallback).
 * Auto-screenshots the main window at open time; submission creates the
 * CNB issue directly, with the prefilled GitHub form as the manual
 * fallback when the report channel fails.
 */
function ReportProblemForm({
  variant,
  onCapturingChange,
}: {
  variant: "dialog" | "window";
  onCapturingChange?: (capturing: boolean) => void;
}) {
  const { t } = useTranslation();
  const { setOpen } = useReportProblemDialog();

  const [description, setDescription] = useState(() => variant === "dialog" ? takePendingReportDescription() : "");
  const [screenshot, setScreenshot] = useState<StagedScreenshot | null>(() =>
    // The dialog's screenshot was captured before the store opened it; the
    // standalone window captures on mount (the main window stays visible).
    variant === "window" ? null : takePendingScreenshot(),
  );
  const [capturing, setCapturing] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [logTail, setLogTail] = useState<LogTail | null>(null);
  const [phase, setPhase] = useState<Phase>("compose");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);

  function close() {
    if (variant === "window") {
      void getCurrentWindow().close();
      return;
    }
    setOpen(false);
  }

  // The standalone window has no store open/close cycle to reset from; keys
  // in App.tsx remount it per open, the dialog resets below.
  useEffect(() => {
    if (variant !== "window") return;
    setPhase("compose");
    setSubmitted(null);
    setSubmitError(null);
    let cancelled = false;
    const api = getDesktopDiagnosticsApi();
    api
      ?.captureScreenshot?.()
      .then((shot) => {
        if (!cancelled) setScreenshot(shot);
      })
      .catch((error: unknown) => {
        if (!cancelled) showScreenshotCaptureError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [variant]);

  // Log tail rides along automatically (no UI toggle): read once, attach on
  // submit, stay silent on failure.
  useEffect(() => {
    let cancelled = false;
    getDesktopDiagnosticsApi()
      ?.readLogs()
      .then((tail) => {
        if (!cancelled) setLogTail(tail);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const retake = useCallback(async () => {
    const api = getDesktopDiagnosticsApi();
    if (!api?.captureScreenshot || capturing) return;
    setCapturing(true);
    onCapturingChange?.(true);
    try {
      // The in-app dialog must actually leave the screen before the capture
      // runs — give the compositor a beat to drop it.
      await new Promise((resolve) => setTimeout(resolve, variant === "dialog" ? 200 : 0));
      const shot = await api.captureScreenshot();
      setPreviewFailed(false);
      setScreenshot(shot);
    } catch (error) {
      showScreenshotCaptureError(error);
    } finally {
      setCapturing(false);
      onCapturingChange?.(false);
    }
  }, [capturing, onCapturingChange, variant]);

  async function handleSubmit() {
    if (!description.trim() || phase === "submitting") return;
    const api = getDesktopDiagnosticsApi();
    const channel = getReportChannel();
    if (!api?.submitCnbIssue || !channel) {
      setSubmitError(t("settings.report_channel_missing"));
      return;
    }
    setPhase("submitting");
    setSubmitError(null);
    const appInfo = getAppInfoSync();
    const version = appInfo?.version || "unknown";
    const platform = appInfo?.platform ?? "unknown";
    try {
      const result = await api.submitCnbIssue({
        endpoint: channel.endpoint,
        title: `[报告] v${version} / ${platform}`,
        body: composeIssueBody({ description, logTail }),
        screenshotPath: screenshot?.path ?? null,
      });
      setSubmitted(result);
      setPhase("submitted");
    } catch (error) {
      setPhase("compose");
      setSubmitError(
        t("settings.report_submit_failed", { error: String(error).slice(0, 200) }),
      );
    }
  }

  /** Manual fallback: the prefilled GitHub issue form in the system browser. */
  function submitInBrowser() {
    openInBrowser(buildIssueUrl({ description, logTail: logTail?.tail ?? undefined }));
    close();
  }

  if (phase === "submitted" && submitted) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <div className="flex size-10 items-center justify-center rounded-full bg-success/15">
          <Check className="size-5 text-success" />
        </div>
        <p className="text-sm font-medium">{t("settings.report_created_title")}</p>
        <p className="max-w-sm text-2xs leading-relaxed text-muted-foreground text-pretty">
          {t("settings.report_created_hint", { number: submitted.number })}
        </p>
        <Button size="sm" className="mt-1 h-7 text-xs" onClick={close}>
          {t("settings.report_done")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        <div className="space-y-1.5">
          <label htmlFor="report-description" className="text-sm font-medium">
            {t("settings.report_problem_label")}
          </label>
          <Textarea
            id="report-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t("settings.report_description_placeholder")}
            className="min-h-28 text-sm"
            autoFocus
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium">{t("settings.report_screenshot_label")}</span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={capturing}
                onClick={() => void retake()}
              >
                {capturing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {t("settings.report_retake")}
              </Button>
              {screenshot && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => {
                    setScreenshot(null);
                    setPreviewFailed(false);
                  }}
                >
                  <X className="size-3.5" />
                  {t("settings.report_remove")}
                </Button>
              )}
            </div>
          </div>
          {screenshot && !previewFailed ? (
            <div className="overflow-hidden rounded-lg border bg-muted/30">
              <img
                src={screenshot.url}
                alt={t("settings.report_screenshot_label")}
                decoding="async"
                onError={() => setPreviewFailed(true)}
                className="max-h-72 w-full object-contain"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void retake()}
              disabled={capturing}
              className="flex aspect-video max-h-72 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-muted-foreground transition-colors hover:bg-muted/30 disabled:opacity-60"
            >
              <Camera className="size-5" />
              <span className="text-xs">
                {previewFailed ? t("settings.report_preview_failed") : t("settings.report_capture_missing")}
              </span>
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t px-5 py-3">
        {submitError && (
          <p className="text-2xs leading-relaxed text-destructive text-pretty">{submitError}</p>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-2xs leading-relaxed text-muted-foreground text-pretty">
            {t("settings.report_footer_hint")}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={close}>
              {t("settings.report_cancel")}
            </Button>
            {submitError && (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={submitInBrowser}>
                {t("settings.report_browser_fallback")}
              </Button>
            )}
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => void handleSubmit()}
              disabled={!description.trim() || phase === "submitting"}
            >
              {phase === "submitting" && <Loader2 className="size-3.5 animate-spin" />}
              {phase === "submitting"
                ? t("settings.report_submitting")
                : t("settings.report_submit")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * In-app problem report dialog — the Windows/web face of the report flow.
 * The whole content fades out while a retake captures the main window, so
 * the dialog never photographs itself.
 */
export function ReportProblemDialog() {
  const { open, setOpen } = useReportProblemDialog();
  const [capturing, setCapturing] = useState(false);
  const contentClassName = useMemo(
    () =>
      `grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 transition-opacity sm:max-w-xl ${
        capturing ? "opacity-0" : "opacity-100"
      }`,
    [capturing],
  );

  // A submitted dialog returns to the compose form on reopen.
  useEffect(() => {
    if (!open) return;
    setCapturing(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className={contentClassName} showCloseButton={false}>
        <DialogHeaderLike />
        <ReportProblemForm variant="dialog" onCapturingChange={setCapturing} />
      </DialogContent>
    </Dialog>
  );
}

/** Title block matching the reference layout (kept dialog-sized). */
function DialogHeaderLike() {
  const { t } = useTranslation();
  return (
    <div className="border-b px-5 py-3.5 pr-12">
      <h2 className="text-base font-semibold leading-tight">{t("settings.report_title")}</h2>
      <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground text-pretty">
        {t("settings.report_subtitle")}
      </p>
    </div>
  );
}

/**
 * Standalone problem-report window (macOS) — the `?window=report` route
 * created by the Rust `open_report_window` command, laid out per the
 * reference: title + subtitle, description box, screenshot with retake and
 * remove, cancel/submit.
 *
 * Runs outside CoreProvider, so it bootstraps i18n itself (see the init
 * below). Re-asserting the native window title keeps it correct if the
 * locale changed since the window was opened.
 */
export function ReportProblemWindow() {
  // The init must happen during render, before useTranslation() below: a
  // passive effect is too late (see about-window.tsx for the full story).
  useMemo(() => initI18n({ resources: RESOURCES }), []);
  const { t } = useTranslation();

  useEffect(() => {
    if (!isTauri) return;
    void getCurrentWindow().setTitle(t("settings.report_title")).catch(() => {});
  }, [t]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <div className="border-b px-6 py-5">
        <h1 className="text-xl font-semibold leading-tight">{t("settings.report_title")}</h1>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground text-pretty">
          {t("settings.report_subtitle")}
        </p>
      </div>
      <ReportProblemForm variant="window" />
    </div>
  );
}
