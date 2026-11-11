"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@lynse/ui/components/ui/button";
import { Textarea } from "@lynse/ui/components/ui/textarea";
import { Input } from "@lynse/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@lynse/ui/components/ui/native-select";
import { cn } from "@lynse/ui/lib/utils";
import { useTranslation } from "@lynse/core/i18n/react";
import { api } from "@lynse/core/api";
import { createFeedbackTicket, type FeedbackSeverity } from "@lynse/core/api";
import { Camera, Check, Loader2, RefreshCw, X } from "../icons";
import { getAppInfoSync } from "../app-update";
import {
  buildIssueUrl,
  getDesktopDiagnosticsApi,
  getReportChannel,
  resolveCaptureBackground,
  showScreenshotCaptureError,
  takePendingScreenshot,
  useReportProblemDialog,
  type LogTail,
  type StagedScreenshot,
} from "../diagnostics";
import { ReportProblemAnnotator } from "../report-problem-annotator";

type Phase = "compose" | "submitting" | "submitted";

/** Module dropdown values (pinned to the Feishu 单选 options — see
 *  lynclaw docs/feedback-feishu-setup.md; keys double as i18n suffixes). */
export const FEEDBACK_MODULES = [
  "recording",
  "knowledge",
  "assistant",
  "live_translation",
  "todo_calendar",
  "account_sync",
  "stability",
  "ui",
  "other",
] as const;

const SEVERITIES: FeedbackSeverity[] = ["P1-高", "P2-中", "P3-低"];

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

/** ZCode-style title: first non-empty line of the description, truncated. */
function deriveTitle(description: string): string {
  const firstLine = description
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstLine ?? description.replace(/\s+/g, " ").trim()).slice(0, 200);
}

/** Raw description + optional log tail; the server composes the environment block. */
function composeDescription(description: string, logTail: LogTail | null): string {
  const body = description.trim();
  if (!logTail?.tail) return body;
  return `${body}\n\n日志（尾部）/ Logs (tail):\n${clampText(logTail.tail, 4000)}`;
}

/**
 * The feature-request submit face of the feedback center. Tickets go to the
 * lynclaw /api/feedback gateway (Feishu Bitable) with the category pinned to
 * "feature" — problem reports take the CNB channel instead (see
 * report-problem-dialog.tsx). The screenshot is captured before the dialog
 * opens (the shared diagnostics store hands it over); it can be annotated
 * like the report form's, and the log tail rides along automatically.
 */
export function FeatureRequestForm({
  onCapturingChange,
  onAnnotatingChange,
  onSubmitted,
}: {
  onCapturingChange?: (capturing: boolean) => void;
  onAnnotatingChange?: (annotating: boolean) => void;
  /** Fired after a ticket is created — the dialog switches to the tickets tab. */
  onSubmitted?: () => void;
}) {
  const { t } = useTranslation();
  const { setOpen } = useReportProblemDialog();

  const [description, setDescription] = useState("");
  const [screenshot, setScreenshot] = useState<StagedScreenshot | null>(() => takePendingScreenshot());
  const [capturing, setCapturing] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [logTail, setLogTail] = useState<LogTail | null>(null);
  const [phase, setPhase] = useState<Phase>("compose");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ ticketId: string } | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [module_, setModule] = useState<string>(FEEDBACK_MODULES[8]);
  const [severity, setSeverity] = useState<FeedbackSeverity>("P2-中");
  const [contact, setContact] = useState("");
  // An older host build without the composite command still shows the
  // preview; it just isn't a way into the editor.
  const [canAnnotate] = useState(() => Boolean(getDesktopDiagnosticsApi()?.saveAnnotatedScreenshot));

  const changeAnnotating = useCallback(
    (value: boolean) => {
      setAnnotating(value);
      onAnnotatingChange?.(value);
    },
    [onAnnotatingChange],
  );

  function close() {
    setOpen(false);
  }

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
      await new Promise((resolve) => setTimeout(resolve, 200));
      const shot = await api.captureScreenshot(resolveCaptureBackground());
      setPreviewFailed(false);
      setScreenshot(shot);
    } catch (error) {
      showScreenshotCaptureError(error);
    } finally {
      setCapturing(false);
      onCapturingChange?.(false);
    }
  }, [capturing, onCapturingChange]);

  /**
   * Burn the editor's overlay into the staged capture. The host hands back
   * a fresh staged file, so the preview and the eventual upload both pick
   * up the marks. Failures keep the editor open with the marks intact.
   */
  const saveAnnotation = useCallback(
    async (overlayDataUrl: string) => {
      const api = getDesktopDiagnosticsApi();
      if (!api?.saveAnnotatedScreenshot || !screenshot) return;
      try {
        const next = await api.saveAnnotatedScreenshot(screenshot.path, overlayDataUrl);
        setPreviewFailed(false);
        setScreenshot(next);
        changeAnnotating(false);
      } catch (error) {
        console.warn("[report-screenshot] annotation save failed:", error);
        toast.error(t("settings.report_annotate_failed"));
        throw error;
      }
    },
    [changeAnnotating, screenshot, t],
  );

  async function handleSubmit() {
    if (!description.trim() || phase === "submitting") return;
    const hostApi = getDesktopDiagnosticsApi();
    const token = api().getToken();
    if (!token) {
      setSubmitError(t("settings.feedback_login_required"));
      return;
    }
    setPhase("submitting");
    setSubmitError(null);
    const appInfo = getAppInfoSync();
    try {
      // Upload the staged screenshot first (best effort, through the report
      // channel's object storage): its public URL is the ticket's screenshot
      // field; a failed upload just drops the field.
      let screenshotUrl: string | undefined;
      const channel = getReportChannel();
      if (screenshot?.path && hostApi?.uploadScreenshot && channel) {
        try {
          const upload = await hostApi.uploadScreenshot({
            endpoint: channel.endpoint,
            path: screenshot.path,
          });
          screenshotUrl = upload.downloadUrl || undefined;
        } catch (uploadError) {
          console.warn("[feedback-center] screenshot upload failed:", uploadError);
        }
      }
      const result = await createFeedbackTicket({
        title: deriveTitle(description) || t("settings.feedback_title_fallback"),
        description: composeDescription(description, logTail),
        category: "feature",
        module: t(`settings.feedback_module_${module_}`),
        severity,
        contact: contact.trim() || undefined,
        screenshot_url: screenshotUrl,
        environment: {
          app_version: appInfo?.version ? `v${appInfo.version}` : undefined,
          platform: appInfo?.platform,
          user_agent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        },
      }, token);
      setSubmitted({ ticketId: result.ticket_id });
      setPhase("submitted");
      onSubmitted?.();
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
          {t("settings.feedback_created_hint")}
        </p>
        <Button size="sm" className="mt-1 h-7 text-xs" onClick={close}>
          {t("settings.report_done")}
        </Button>
      </div>
    );
  }

  if (annotating && screenshot) {
    return (
      <ReportProblemAnnotator
        screenshot={screenshot}
        onClose={() => changeAnnotating(false)}
        onSave={saveAnnotation}
      />
    );
  }

  const previewClickable = canAnnotate && !capturing;

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

        {/* Classification row: module / severity / contact — the lightweight
            form the server composes into the ticket body. The ticket type is
            pinned to "feature" (this surface only takes feature requests). */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="feedback-module" className="text-xs font-medium text-muted-foreground">
              {t("settings.feedback_module_label")}
            </label>
            <NativeSelect
              id="feedback-module"
              value={module_}
              onChange={(event) => setModule(event.target.value)}
              className="h-8 text-xs"
            >
              {FEEDBACK_MODULES.map((key) => (
                <NativeSelectOption key={key} value={key}>
                  {t(`settings.feedback_module_${key}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="feedback-severity" className="text-xs font-medium text-muted-foreground">
              {t("settings.feedback_severity_label")}
            </label>
            <NativeSelect
              id="feedback-severity"
              value={severity}
              onChange={(event) => setSeverity(event.target.value as FeedbackSeverity)}
              className="h-8 text-xs"
            >
              {SEVERITIES.map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {t(`settings.feedback_severity_${value === "P1-高" ? "p1" : value === "P2-中" ? "p2" : "p3"}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="col-span-2 space-y-1.5">
            <label htmlFor="feedback-contact" className="text-xs font-medium text-muted-foreground">
              {t("settings.feedback_contact_label")}
            </label>
            <Input
              id="feedback-contact"
              value={contact}
              onChange={(event) => setContact(event.target.value)}
              placeholder={t("settings.feedback_contact_placeholder")}
              className="h-8 text-xs"
            />
          </div>
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
            <>
              <div className="overflow-hidden rounded-lg border bg-muted/30">
                <img
                  src={screenshot.url}
                  alt={t("settings.report_screenshot_label")}
                  decoding="async"
                  onError={() => setPreviewFailed(true)}
                  onClick={previewClickable ? () => changeAnnotating(true) : undefined}
                  className={cn("max-h-72 w-full object-contain", previewClickable && "cursor-zoom-in")}
                />
              </div>
              {canAnnotate && (
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  {t("settings.report_annotate_hint")}
                </p>
              )}
            </>
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
