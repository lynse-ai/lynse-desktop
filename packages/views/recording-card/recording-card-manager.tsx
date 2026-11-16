"use client";

import { useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Progress } from "@lynse/ui/components/ui/progress";
import { Switch } from "@lynse/ui/components/ui/switch";
import { Loader2, RefreshCw, Usb } from "../icons";
import { useRecordingCardSession } from "./use-recording-card-session";
import type { NvEasyDeviceFile } from "./nveasy-types";

/**
 * The recording-card USB management view. Rendered by the standalone web
 * route inside an AuthGate (logged-out visitors see the login page here and
 * land back on this view). The card's USB link lives entirely in the
 * browser (WebUSB); nothing about it goes through Lynse servers except the
 * firmware pairing password fetched after sign-in.
 */
export function RecordingCardManager() {
  const { t } = useTranslation();
  const session = useRecordingCardSession();
  const [copied, setCopied] = useState(false);
  // Two-step delete: holds the file name armed for confirmation, mirroring
  // the plugin row's uninstall confirm.
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  const copyLink = () => {
    void navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }
    if (bytes >= 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (bytes >= 1024) {
      return `${(bytes / 1024).toFixed(0)} KB`;
    }
    return `${bytes} B`;
  }

  function formatTime(unixSeconds: number): string {
    if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return "—";
    return new Date(unixSeconds * 1000).toLocaleString();
  }

  function handleDelete(file: NvEasyDeviceFile) {
    if (confirmingDelete !== file.name) {
      setConfirmingDelete(file.name);
      return;
    }
    setConfirmingDelete(null);
    session.deleteFile(file.name);
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
          <Usb className="size-5 text-muted-foreground" />
        </span>
        <div>
          <h1 className="text-base font-medium">{t("recordingCard.title")}</h1>
          <p className="text-2xs text-muted-foreground">{t("recordingCard.subtitle")}</p>
        </div>
      </div>

      {!session.supported && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("recordingCard.unsupported_title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-2xs leading-relaxed text-muted-foreground">
              {t("recordingCard.unsupported_body")}
            </p>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={copyLink}>
              {copied ? t("recordingCard.unsupported_copied") : t("recordingCard.unsupported_copy")}
            </Button>
          </CardContent>
        </Card>
      )}

      {session.supported && (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-xs">{t("recordingCard.usb_access")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  {t("recordingCard.usb_hint")}
                </p>
                <Switch
                  checked={session.usbEnabled}
                  onCheckedChange={session.setAccess}
                  aria-label={t("recordingCard.usb_access")}
                />
              </div>

              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2 text-xs">
                  {session.phase === "connecting" && (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                  )}
                  {session.phase === "connected" ? (
                    <span className="truncate">
                      {t("recordingCard.status_connected", { name: session.deviceName ?? "" })}
                    </span>
                  ) : session.phase === "connecting" ? (
                    <span>{t("recordingCard.status_connecting")}</span>
                  ) : session.phase === "error" ? (
                    <span className="min-w-0 break-all text-destructive">
                      {t("recordingCard.err_connect_failed", {
                        message: session.errorMessage ?? "",
                      })}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t("recordingCard.status_off")}</span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {session.phase === "error" && (
                    <Button size="sm" className="h-7 text-xs" onClick={session.connect}>
                      {t("recordingCard.retry")}
                    </Button>
                  )}
                  {session.usbEnabled && session.phase === "off" && (
                    <Button size="sm" className="h-7 text-xs" onClick={session.connect}>
                      {t("recordingCard.connect")}
                    </Button>
                  )}
                  {session.phase === "connected" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => session.setAccess(false)}
                    >
                      {t("recordingCard.disconnect")}
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {session.phase === "connected" && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-xs">{t("recordingCard.files_title")}</CardTitle>
                <div className="flex items-center gap-2">
                  {session.storage && (
                    <span className="text-2xs text-muted-foreground">
                      {t("recordingCard.storage_free", {
                        free: formatBytes(session.storage.freeSpace * 1024),
                        total: formatBytes(session.storage.totalSpace * 1024),
                      })}
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={session.refreshFiles}
                    disabled={session.downloading}
                  >
                    <RefreshCw className="mr-1 size-3" />
                    {t("recordingCard.refresh")}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {session.actionError && (
                  <p className="break-all rounded-md bg-destructive/10 px-2.5 py-1.5 text-2xs text-destructive">
                    {t("recordingCard.action_failed", { message: session.actionError })}
                  </p>
                )}

                {session.download && (
                  <div className="rounded-md border bg-muted/30 p-2.5">
                    <div className="mb-1.5 flex items-center justify-between text-2xs">
                      <span className="truncate font-medium">{session.download.fileName}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {t("recordingCard.download_progress", {
                          percent:
                            session.download.total > 0
                              ? Math.min(
                                  100,
                                  Math.round((session.download.loaded / session.download.total) * 100),
                                )
                              : 0,
                        })}
                      </span>
                    </div>
                    <Progress
                      value={
                        session.download.total > 0
                          ? Math.min(100, (session.download.loaded / session.download.total) * 100)
                          : 0
                      }
                    />
                  </div>
                )}

                {session.listError && (
                  <p className="text-2xs text-destructive">{t("recordingCard.list_failed")}</p>
                )}

                {session.files.length === 0 && !session.listError ? (
                  <p className="py-4 text-center text-2xs text-muted-foreground">
                    {t("recordingCard.empty")}
                  </p>
                ) : (
                  session.files.map((file) => (
                    <FileRow
                      key={file.sn}
                      file={file}
                      formatBytes={formatBytes}
                      formatTime={formatTime}
                      downloadDisabled={session.downloading}
                      deleteDisabled={session.downloading}
                      confirmingDelete={confirmingDelete === file.name}
                      onDownload={() => session.downloadFile(file)}
                      onDelete={() => handleDelete(file)}
                      onDisarmDelete={() => setConfirmingDelete(null)}
                      labels={{
                        download: t("recordingCard.download"),
                        delete: t("recordingCard.delete"),
                        deleteConfirm: t("recordingCard.delete_confirm"),
                      }}
                    />
                  ))
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function FileRow({
  file,
  formatBytes,
  formatTime,
  downloadDisabled,
  deleteDisabled,
  confirmingDelete,
  onDownload,
  onDelete,
  onDisarmDelete,
  labels,
}: {
  file: NvEasyDeviceFile;
  formatBytes: (bytes: number) => string;
  formatTime: (unixSeconds: number) => string;
  downloadDisabled: boolean;
  deleteDisabled: boolean;
  confirmingDelete: boolean;
  onDownload: () => void;
  onDelete: () => void;
  onDisarmDelete: () => void;
  labels: { download: string; delete: string; deleteConfirm: string };
}) {
  return (
    <div className="flex items-center gap-3 rounded-md border bg-background p-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{file.name}</p>
        <p className="mt-0.5 text-2xs text-muted-foreground">
          {formatBytes(file.size)} · {formatTime(file.startTime)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={onDownload}
          disabled={downloadDisabled}
        >
          {labels.download}
        </Button>
        <Button
          size="sm"
          variant={confirmingDelete ? "destructive" : "ghost"}
          className="h-7 text-xs"
          onClick={onDelete}
          onBlur={onDisarmDelete}
          disabled={deleteDisabled}
        >
          {confirmingDelete ? labels.deleteConfirm : labels.delete}
        </Button>
      </div>
    </div>
  );
}
