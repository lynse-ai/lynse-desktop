"use client";

import { useCallback, useEffect, useState, type ClipboardEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { Label } from "@lynse/ui/components/ui/label";
import { Switch } from "@lynse/ui/components/ui/switch";
import { Textarea } from "@lynse/ui/components/ui/textarea";
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import { Check, Copy, FolderOpen, Image, Loader2, X } from "./icons";
import { getAppInfoSync } from "./app-update";
import {
  buildIssueUrl,
  getDesktopDiagnosticsApi,
  useReportProblemDialog,
  type LogTail,
} from "./diagnostics";
import { getDesktopInspirationApi } from "./inspiration/desktop-api";

type StagedAttachment = { path: string; url: string };
type Phase = "compose" | "submitting" | "submitted";

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * In-app bug report dialog: the user describes the problem, attaches
 * screenshots (clipboard paste or image picker), and the recent app log tail
 * rides along automatically. Submission opens the prefilled GitHub issue form
 * and assembles a local report folder (markdown + screenshots + log copies)
 * for drag-and-drop attachments, since the issue API needs a token that can't
 * ship in a client build.
 */
export function ReportProblemDialog() {
  const { open, setOpen } = useReportProblemDialog();
  const { t } = useTranslation();

  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState("");
  const [attachments, setAttachments] = useState<StagedAttachment[]>([]);
  const [includeLogs, setIncludeLogs] = useState(true);
  const [logTail, setLogTail] = useState<LogTail | null>(null);
  const [logFailed, setLogFailed] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("compose");
  const [submitted, setSubmitted] = useState<{ dir: string; url: string } | null>(null);

  const diagnosticsApi = getDesktopDiagnosticsApi();
  const inspirationApi = getDesktopInspirationApi();

  // A submitted dialog returns to the compose form on reopen; text drafts are
  // kept so an accidental close doesn't lose the description.
  useEffect(() => {
    if (!open) return;
    setPhase("compose");
    setSubmitted(null);
  }, [open]);

  // Load the log tail once per open so the "logs attached" line can show real
  // status instead of a promise.
  useEffect(() => {
    if (!open || !diagnosticsApi) return;
    let cancelled = false;
    setLogFailed(null);
    diagnosticsApi
      .readLogs()
      .then((tail) => {
        if (!cancelled) setLogTail(tail);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLogFailed(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, diagnosticsApi]);

  const stageFromClipboard = useCallback(async () => {
    if (!inspirationApi) return;
    try {
      const staged = await inspirationApi.stageImageFromClipboard();
      setAttachments((current) =>
        current.some((item) => item.path === staged.path) ? current : [...current, staged],
      );
    } catch {
      toast.error(t("settings.report_clipboard_empty"));
    }
  }, [inspirationApi, t]);

  const stageFromFiles = useCallback(async () => {
    if (!inspirationApi) return;
    const picked = await inspirationApi.pickImages().catch(() => [] as string[]);
    for (const path of picked) {
      try {
        const staged = await inspirationApi.stageImageFromPath(path);
        setAttachments((current) =>
          current.some((item) => item.path === staged.path) ? current : [...current, staged],
        );
      } catch {
        toast.error(t("settings.report_attach_failed"));
      }
    }
  }, [inspirationApi, t]);

  // Paste with focus inside the dialog: attach image clips directly without
  // disturbing plain-text paste into the description fields.
  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const file = Array.from(event.clipboardData?.files ?? []).find((item) =>
      item.type.startsWith("image/"),
    );
    if (!file) return;
    event.preventDefault();
    void file
      .arrayBuffer()
      .then(async (buffer) => {
        if (!inspirationApi) return;
        const staged = await inspirationApi.stageImage(new Uint8Array(buffer));
        setAttachments((current) =>
          current.some((item) => item.path === staged.path) ? current : [...current, staged],
        );
      })
      .catch(() => stageFromClipboard());
  };

  function removeAttachment(index: number) {
    setAttachments((current) => current.filter((_, i) => i !== index));
  }

  function composeMarkdown(): string {
    const appInfo = getAppInfoSync();
    const lines = [
      "## 问题描述 / What happened",
      description.trim(),
      "",
      "## 复现步骤 / Steps to reproduce",
      steps.trim() || "（未提供 / not provided）",
      "",
      "## 环境 / Environment",
      `- App: v${appInfo?.version ?? "unknown"}`,
      `- Platform: ${appInfo?.platform ?? "unknown"}`,
      `- User agent: ${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}`,
      `- Date: ${new Date().toISOString()}`,
      `- Screenshots: ${attachments.length}`,
    ];
    if (includeLogs && logTail?.tail) {
      lines.push("", "## 日志（尾部）/ Logs (tail)", "```text", logTail.tail, "```");
    }
    return lines.join("\n");
  }

  async function handleSubmit() {
    if (!description.trim() || phase === "submitting") return;
    setPhase("submitting");
    const url = buildIssueUrl({
      description,
      steps,
      logTail: includeLogs ? (logTail?.tail ?? undefined) : undefined,
    });
    let dir: string | null = null;
    if (diagnosticsApi) {
      try {
        dir = (
          await diagnosticsApi.prepareReport({
            markdown: composeMarkdown(),
            attachments: attachments.map((attachment) => attachment.path),
            includeLogs,
          })
        ).dir;
      } catch {
        // The bundle is a convenience copy; the issue form still opens.
      }
    }
    openInBrowser(url);
    setSubmitted(dir ? { dir, url } : { dir: "", url });
    setPhase("submitted");
  }

  // When screenshots were attached, reveal the report folder so the user can
  // drag them onto the GitHub issue form.
  useEffect(() => {
    if (phase !== "submitted" || !submitted?.dir || attachments.length === 0) return;
    void diagnosticsApi?.revealReportFolder(submitted.dir).catch(() => {});
  }, [phase, submitted, attachments.length, diagnosticsApi]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-lg"
        onPaste={handlePaste}
      >
        {phase === "submitted" && submitted ? (
          <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
            <div className="flex size-10 items-center justify-center rounded-full bg-success/15">
              <Check className="size-5 text-success" />
            </div>
            <p className="text-sm font-medium">{t("settings.report_submitted_title")}</p>
            <p className="max-w-sm text-2xs leading-relaxed text-muted-foreground">
              {t("settings.report_submitted_hint")}
            </p>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              {submitted.dir && diagnosticsApi && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => void diagnosticsApi.revealReportFolder(submitted.dir)}
                >
                  <FolderOpen className="size-3.5" />
                  {t("settings.report_open_folder")}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                onClick={() => openInBrowser(submitted.url)}
              >
                {t("settings.report_open_issue")}
              </Button>
              <Button size="sm" className="h-7 text-xs" onClick={() => setOpen(false)}>
                {t("settings.report_done")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <DialogHeader className="border-b px-4 py-3 pr-12">
              <DialogTitle>{t("settings.report_title")}</DialogTitle>
            </DialogHeader>

            <div className="min-h-0 space-y-4 overflow-y-auto px-4 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="report-description" className="text-xs">
                  {t("settings.report_description_label")}
                </Label>
                <Textarea
                  id="report-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t("settings.report_description_placeholder")}
                  className="min-h-20 text-xs"
                  autoFocus
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="report-steps" className="text-xs">
                  {t("settings.report_steps_label")}
                </Label>
                <Textarea
                  id="report-steps"
                  value={steps}
                  onChange={(event) => setSteps(event.target.value)}
                  placeholder={t("settings.report_steps_placeholder")}
                  className="min-h-16 text-xs"
                />
              </div>

              {inspirationApi && (
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("settings.report_attachments_label")}</Label>
                  {attachments.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {attachments.map((attachment, index) => (
                        <div
                          key={attachment.path}
                          className="relative size-16 overflow-hidden rounded-md border"
                        >
                          <img src={attachment.url} alt="" className="size-full object-cover" />
                          <button
                            type="button"
                            aria-label={t("settings.report_remove_attachment")}
                            onClick={() => removeAttachment(index)}
                            className="absolute top-0.5 right-0.5 rounded-full bg-background/85 p-0.5 text-foreground transition-colors hover:bg-background"
                          >
                            <X className="size-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => void stageFromClipboard()}
                    >
                      <Copy className="size-3.5" />
                      {t("settings.report_attach_clipboard")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => void stageFromFiles()}
                    >
                      <Image className="size-3.5" />
                      {t("settings.report_attach_files")}
                    </Button>
                  </div>
                </div>
              )}

              {diagnosticsApi && (
                <div className="rounded-md border bg-muted/30 p-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="report-logs" className="text-xs">
                      {t("settings.report_logs_label")}
                    </Label>
                    <Switch
                      id="report-logs"
                      checked={includeLogs}
                      onCheckedChange={setIncludeLogs}
                    />
                  </div>
                  <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
                    {logFailed
                      ? t("settings.report_logs_failed", { error: logFailed })
                      : logTail
                        ? t("settings.report_logs_ready", { size: formatBytes(logTail.tail.length) })
                        : t("settings.report_logs_loading")}
                  </p>
                  {logTail?.truncated && !logFailed && (
                    <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">
                      {t("settings.report_logs_truncated")}
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
              <p className="min-w-0 text-2xs leading-relaxed text-muted-foreground">
                {t("settings.report_footer_hint")}
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => setOpen(false)}
                >
                  {t("settings.report_cancel")}
                </Button>
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
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
