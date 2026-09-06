"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { PageHeader } from "../layout/page-header";
import {
  Bluetooth,
  RefreshCw,
  Plus,
  BatteryFull,
  BatteryLow,
  HardDrive,
  Cpu,
  CircleDot,
  Mic,
  Square,
  Pause,
  Play,
  Download,
  Trash2,
  FileAudio,
  Loader2,
  Signal,
  X,
  FileText,
  AlertCircle,
} from "../icons";
import { Button } from "@lynse/ui/components/ui/button";
import { Switch } from "@lynse/ui/components/ui/switch";
import { Progress } from "@lynse/ui/components/ui/progress";
import { formatCardBytes, formatCardDate } from "./format";
import type {
  CardFile,
  CardStateSnapshot,
  RecordingCardEvent,
} from "./types";
import { getRecordingCardApi } from "./desktop-api";
import { AddDeviceDialog } from "./add-device-dialog";

export function DevicesPage() {
  const { t } = useTranslation();
  const api = useMemo(() => getRecordingCardApi(), []);
  const [snapshot, setSnapshot] = useState<CardStateSnapshot | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [level, setLevel] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [importingSn, setImportingSn] = useState<number | null>(null);
  const levelResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setSnapshot(await api.state());
    } catch {
      /* transient IPC failure — the poller retries */
    }
  }, [api]);

  useEffect(() => {
    if (!api) return;
    void refresh();
    const poller = setInterval(() => void refresh(), 3000);
    let dispose: (() => void) | undefined;
    void api.onEvent((event: RecordingCardEvent) => {
      switch (event.type) {
        case "scan":
        case "files":
        case "transfer":
        case "connection":
        case "record":
        case "connected":
        case "settings":
          void refresh();
          break;
        case "level":
          setLevel(event.level);
          if (levelResetTimer.current) clearTimeout(levelResetTimer.current);
          levelResetTimer.current = setTimeout(() => setLevel(0), 400);
          break;
        case "error":
          toast.error(event.message);
          break;
      }
    }).then((disposeFn: () => void) => {
      dispose = disposeFn;
    });
    return () => {
      clearInterval(poller);
      dispose?.();
      if (levelResetTimer.current) clearTimeout(levelResetTimer.current);
    };
  }, [api, refresh]);

  if (!api) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <PageHeader className="h-auto min-h-14 py-3">
          <h1 className="text-sm font-semibold tracking-tight text-foreground">
            {t("devices.title")}
          </h1>
        </PageHeader>
        <main className="flex min-h-0 flex-1 items-center justify-center">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <Bluetooth className="size-10 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">
              {t("devices.desktop_only")}
            </p>
          </div>
        </main>
      </div>
    );
  }

  const connected = snapshot?.connected ?? false;
  const recording = snapshot?.recording ?? null;

  const runRecord = async (
    action: "start" | "stop" | "pause" | "resume" | "mark",
    mode?: "meeting" | "call" | "media",
  ) => {
    setBusy(action);
    try {
      await api.record(action, mode);
      if (action === "mark") toast.success(t("devices.mark_added"));
      await refresh();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setBusy(null);
    }
  };

  const importToTranscription = async (file: CardFile) => {
    const desktop = (window as unknown as {
      desktopAPI?: {
        localTranscription?: {
          transcribe: (path: string, options?: unknown) => Promise<unknown>;
        };
      };
    }).desktopAPI;
    if (!desktop?.localTranscription) {
      toast.error(t("devices.desktop_only"));
      return;
    }
    setImportingSn(file.sn);
    try {
      const wavPath = await api.transcribeSource(file.name, file.sn, file.frameBytes);
      await desktop.localTranscription.transcribe(wavPath);
      toast.success(t("devices.import_started"));
    } catch (error) {
      toast.error(String(error));
    } finally {
      setImportingSn(null);
    }
  };

  const transfer = snapshot?.transfer ?? null;
  const transferActive = transfer != null && !transfer.finished;
  const transferPercent =
    transfer && transfer.totalBytes > 0
      ? Math.min(100, Math.round((transfer.receivedBytes / transfer.totalBytes) * 100))
      : 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <PageHeader className="h-auto min-h-14 py-3">
        <div className="flex flex-1 items-center gap-4">
          <div className="min-w-0">
            <h1 className="text-sm font-semibold tracking-tight text-foreground">
              {t("devices.title")}
            </h1>
            <p className="mt-0.5 text-2xs text-muted-foreground">
              {t("devices.subtitle")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {connected && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 rounded-lg border-border bg-card text-xs text-muted-foreground shadow-sm hover:border-destructive/40 hover:text-destructive"
              onClick={async () => {
                try {
                  await api.disconnect();
                  await refresh();
                } catch (error) {
                  toast.error(String(error));
                }
              }}
            >
              {t("devices.disconnect")}
            </Button>
          )}
          <Button
            size="sm"
            className="h-8 gap-1.5 rounded-lg bg-primary text-xs text-primary-foreground shadow-sm hover:bg-primary/90"
            onClick={() => setAddOpen(true)}
          >
            <Plus className="size-3.5" />
            {t("devices.add_device")}
          </Button>
        </div>
      </PageHeader>

      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {snapshot?.bluetoothError && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{snapshot.bluetoothError}</span>
          </div>
        )}

        {!snapshot || !connected ? (
          <EmptyState
            snapshot={snapshot}
            onAdd={() => setAddOpen(true)}
            onReconnect={() => setAddOpen(true)}
          />
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
            {/* Device status card */}
            <DeviceCard snapshot={snapshot} onRefresh={refresh} />

            {/* Recording control card */}
            <section className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-semibold text-foreground">
                  {t("devices.recording_control")}
                </h2>
                {recording?.status === "recording" && (
                  <span className="flex items-center gap-1.5 text-2xs text-red-500">
                    <CircleDot className="size-3 animate-pulse" />
                    {formatDuration(recording.durationMs ?? 0)}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {recording?.status === "recording" || recording?.status === "paused" ? (
                  <>
                    {recording.status === "recording" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1.5 text-xs"
                        disabled={busy !== null}
                        onClick={() => void runRecord("pause")}
                      >
                        {busy === "pause" ? <Loader2 className="size-3.5 animate-spin" /> : <Pause className="size-3.5" />}
                        {t("devices.pause")}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 gap-1.5 text-xs"
                        disabled={busy !== null}
                        onClick={() => void runRecord("resume")}
                      >
                        {busy === "resume" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                        {t("devices.resume")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      className="h-8 gap-1.5 bg-destructive text-xs text-white hover:bg-destructive/90"
                      disabled={busy !== null}
                      onClick={() => void runRecord("stop")}
                    >
                      {busy === "stop" ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
                      {t("devices.stop_recording")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1.5 text-xs"
                      disabled={busy !== null}
                      onClick={() => void runRecord("mark")}
                    >
                      <Signal className="size-3.5" />
                      {t("devices.add_mark")}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      className="h-8 gap-1.5 bg-primary text-xs text-primary-foreground hover:bg-primary/90"
                      disabled={busy !== null}
                      onClick={() => void runRecord("start", "meeting")}
                    >
                      {busy === "start" ? <Loader2 className="size-3.5 animate-spin" /> : <Mic className="size-3.5" />}
                      {t("devices.start_meeting")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1.5 text-xs"
                      disabled={busy !== null}
                      onClick={() => void runRecord("start", "call")}
                    >
                      <Mic className="size-3.5" />
                      {t("devices.start_call")}
                    </Button>
                  </>
                )}
                {/* Live level meter */}
                <div className="ml-auto flex h-8 w-28 items-center gap-1" aria-hidden>
                  {Array.from({ length: 12 }).map((_, index) => (
                    <div
                      key={index}
                      className={
                        "w-1.5 rounded-full transition-colors " +
                        (level * 12 > index
                          ? index > 9
                            ? "bg-red-500/80"
                            : index > 7
                              ? "bg-amber-500/80"
                              : "bg-emerald-500/80"
                          : "bg-muted")
                      }
                      style={{ height: `${30 + Math.abs(6 - index) * -1 + index * 0}%` , minHeight: 8 }}
                    />
                  ))}
                </div>
              </div>
              <label className="mt-3 flex cursor-pointer items-center gap-2 text-2xs text-muted-foreground">
                <Switch
                  checked={snapshot?.liveFeedEnabled ?? false}
                  onCheckedChange={async (checked) => {
                    try {
                      await api.setLiveFeed(checked);
                      await refresh();
                    } catch (error) {
                      toast.error(String(error));
                    }
                  }}
                />
                {t("devices.live_feed_hint")}
              </label>
            </section>

            {/* Transfer progress card */}
            {transfer && (
              <section className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2 className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-foreground">
                    <FileAudio className="size-3.5 shrink-0 text-primary" />
                    <span className="truncate">{transfer.name}</span>
                  </h2>
                  {transferActive ? (
                    <div className="flex items-center gap-2">
                      <span className="text-2xs tabular-nums text-muted-foreground">
                        {transferPercent}%
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        onClick={async () => {
                          try {
                            await api.cancelDownload();
                          } catch (error) {
                            toast.error(String(error));
                          }
                        }}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground"
                      onClick={() => void refresh()}
                    >
                      <X className="size-3.5" />
                    </Button>
                  )}
                </div>
                <Progress value={transferPercent} className="h-1.5" />
                {transfer.finished && (
                  <p
                    className={
                      "mt-2 text-2xs " +
                      (transfer.error ? "text-destructive" : "text-emerald-600")
                    }
                  >
                    {transfer.error ?? t("devices.transfer_done")}
                  </p>
                )}
              </section>
            )}

            {/* Files card */}
            <section className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xs font-semibold text-foreground">
                  {t("devices.files")}
                </h2>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 rounded-lg text-xs"
                  disabled={transferActive}
                  onClick={async () => {
                    try {
                      await api.listFiles();
                    } catch (error) {
                      toast.error(String(error));
                    }
                  }}
                >
                  <RefreshCw className="size-3" />
                  {t("devices.refresh_files")}
                </Button>
              </div>
              {snapshot?.files.length === 0 ? (
                <p className="py-6 text-center text-2xs text-muted-foreground">
                  {t("devices.no_files")}
                </p>
              ) : (
                <ul className="flex flex-col divide-y divide-border/40">
                  {(snapshot?.files ?? []).map((file) => {
                    const isTransferring =
                      transferActive && transfer?.sn === file.sn;
                    return (
                      <li
                        key={`${file.sn}-${file.name}`}
                        className="flex items-center gap-3 py-2.5"
                      >
                        <FileAudio className="size-4 shrink-0 text-muted-foreground/70" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-foreground">
                            {formatCardDate(file.name)}
                          </p>
                          <p className="text-2xs text-muted-foreground">
                            {formatCardBytes(file.size)}
                            {file.scene === 1
                              ? ` · ${t("devices.mode_call")}`
                              : ` · ${t("devices.mode_meeting")}`}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {isTransferring ? (
                            <span className="text-2xs tabular-nums text-muted-foreground">
                              {transferPercent}%
                            </span>
                          ) : (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                                disabled={transferActive || importingSn !== null}
                                onClick={async () => {
                                  try {
                                    await api.download(
                                      {
                                        sn: file.sn,
                                        name: file.name,
                                        size: file.size,
                                        frameBytes: file.frameBytes,
                                      },
                                      false,
                                    );
                                  } catch (error) {
                                    toast.error(String(error));
                                  }
                                }}
                              >
                                <Download className="size-3.5" />
                                {t("devices.download")}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                                disabled={transferActive || importingSn !== null}
                                onClick={() => void importToTranscription(file)}
                              >
                                {importingSn === file.sn ? (
                                  <Loader2 className="size-3.5 animate-spin" />
                                ) : (
                                  <FileText className="size-3.5" />
                                )}
                                {t("devices.import_transcribe")}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                                disabled={transferActive}
                                onClick={async () => {
                                  try {
                                    await api.deleteFile(file.sn, file.name);
                                    toast.success(t("devices.file_deleted"));
                                  } catch (error) {
                                    toast.error(String(error));
                                  }
                                }}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        )}
      </main>

      <AddDeviceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        manufacturerCodeSet={snapshot?.manufacturerCodeSet ?? false}
        onConnected={async () => {
          setAddOpen(false);
          await refresh();
        }}
      />
    </div>
  );
}

function EmptyState({
  snapshot,
  onAdd,
}: {
  snapshot: CardStateSnapshot | null;
  onAdd: () => void;
  onReconnect: () => void;
}) {
  const { t } = useTranslation();
  const saved = snapshot?.savedDevice;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10">
          <Bluetooth className="size-7 text-primary" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">
            {t("devices.empty_title")}
          </p>
          <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
            {t("devices.empty_hint")}
          </p>
        </div>
        <Button size="sm" className="h-8 gap-1.5 rounded-lg text-xs" onClick={onAdd}>
          <Plus className="size-3.5" />
          {t("devices.add_device")}
        </Button>
        {saved && (
          <p className="text-2xs text-muted-foreground">
            {t("devices.saved_device", { name: saved.name })}
          </p>
        )}
      </div>
    </div>
  );
}

function DeviceCard({
  snapshot,
  onRefresh,
}: {
  snapshot: CardStateSnapshot;
  onRefresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const api = getRecordingCardApi();
  const device = snapshot.device;
  const battery = snapshot.battery;
  const batteryPercent = battery ? Math.max(battery.left, battery.right, battery.main) : null;
  const memory = snapshot.memory;
  const recording = snapshot.recording;

  const infoRows: Array<[string, string | null | undefined]> = [
    [t("devices.model"), device.sku ?? null],
    [t("devices.firmware"), device.softwareVersion ?? null],
    [
      t("devices.protocol_version"),
      device.protocolVersion != null ? `v${device.protocolVersion}` : null,
    ],
  ];

  return (
    <section className="rounded-xl border border-border/60 bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <Bluetooth className="size-5 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">{device.name}</p>
            <p className="text-2xs text-muted-foreground">
              {recording?.status === "recording"
                ? t("devices.status_recording")
                : recording?.status === "paused"
                  ? t("devices.status_paused")
                  : t("devices.status_connected")}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-muted-foreground"
            title={t("devices.refresh_status")}
            onClick={async () => {
              if (!api) return;
              try {
                await Promise.all([
                  api.query("battery"),
                  api.query("memory"),
                  api.query("version"),
                ]);
                await onRefresh();
              } catch {
                /* re-queried by poller */
              }
            }}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-2">
          {batteryPercent != null && batteryPercent > 20 ? (
            <BatteryFull className="size-4 shrink-0 text-emerald-600" />
          ) : (
            <BatteryLow className="size-4 shrink-0 text-amber-600" />
          )}
          <div className="min-w-0">
            <p className="text-2xs text-muted-foreground">{t("devices.battery")}</p>
            <p className="truncate text-xs font-medium text-foreground">
              {batteryPercent != null ? `${batteryPercent}%` : "—"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-2">
          <HardDrive className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-2xs text-muted-foreground">{t("devices.storage")}</p>
            <p className="truncate text-xs font-medium text-foreground">
              {memory
                ? t("devices.storage_value", {
                    free: formatCardBytes(memory.freeKb * 1024),
                    total: formatCardBytes(memory.totalKb * 1024),
                  })
                : "—"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-2">
          <Cpu className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-2xs text-muted-foreground">{t("devices.firmware")}</p>
            <p className="truncate text-xs font-medium text-foreground">
              {device.softwareVersion || "—"}
            </p>
          </div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground">
        {infoRows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <span key={label}>
              {label}: <span className="text-foreground">{value}</span>
            </span>
          ))}
      </div>
    </section>
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
