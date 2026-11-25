"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@lynse/ui/components/ui/alert-dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { Card, CardContent } from "@lynse/ui/components/ui/card";
import { Input } from "@lynse/ui/components/ui/input";
import {
  Check,
  ChevronRight,
  Copy,
  HardDrive,
  Loader2,
  Settings,
  Wrench,
} from "../icons";
import type { RecordingCardMicMode, RecordingCardSessionView } from "./transport";
import { ownershipErrorKey } from "./ownership";

type ConfirmAction = "unbind" | "factoryReset" | "formatStorage" | null;

export function DeviceOverview({
  session,
  onOpenFiles,
  formatBytes,
}: {
  session: RecordingCardSessionView;
  onOpenFiles: () => void;
  formatBytes: (bytes: number) => string;
}) {
  const { t } = useTranslation();
  const errorKey = session.errorMessage && ownershipErrorKey(session.errorMessage);
  const [copied, setCopied] = useState(false);
  const [editingAutoOff, setEditingAutoOff] = useState(false);
  const [autoOffDraft, setAutoOffDraft] = useState("");
  const [autoOffError, setAutoOffError] = useState(false);
  const [editingMic, setEditingMic] = useState(false);
  const [micMode, setMicMode] = useState<RecordingCardMicMode>(0);
  const [mic1Draft, setMic1Draft] = useState("0");
  const [mic2Draft, setMic2Draft] = useState("0");
  const [micError, setMicError] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmAction>(null);

  const { refreshMicGain, settingsLoading: busy } = session;

  useEffect(() => {
    if (session.autoOffMinutes !== null) setAutoOffDraft(String(session.autoOffMinutes));
  }, [session.autoOffMinutes]);

  useEffect(() => {
    if (session.micGain) {
      setMic1Draft(String(session.micGain.mic1));
      setMic2Draft(String(session.micGain.mic2));
    }
  }, [session.micGain]);

  useEffect(() => {
    if (editingMic) void refreshMicGain(micMode);
  }, [editingMic, micMode, refreshMicGain]);

  const serial = session.deviceSn ?? session.deviceName ?? "";
  const clockLabel =
    session.clockSynced === true
      ? t("recordingCard.clock_synced")
      : session.clockSynced === false
        ? t("recordingCard.clock_unsynced")
        : t("recordingCard.clock_unknown");

  const storageTotalBytes = (session.storage?.totalSpace ?? 0) * 1024;
  const storageFreeBytes = (session.storage?.freeSpace ?? 0) * 1024;
  const storageUsedBytes = Math.max(0, storageTotalBytes - storageFreeBytes);
  const storageUsedPercent =
    storageTotalBytes > 0
      ? Math.min(100, Math.max(0, (storageUsedBytes / storageTotalBytes) * 100))
      : 0;

  const copySerial = () => {
    if (!serial) return;
    void navigator.clipboard?.writeText(serial).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const saveAutoOff = async () => {
    const minutes = Number(autoOffDraft);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 36_000) {
      setAutoOffError(true);
      return;
    }
    setAutoOffError(false);
    if (await session.setAutoOff(minutes)) setEditingAutoOff(false);
  };

  const saveMicGain = async () => {
    const mic1 = Number(mic1Draft);
    const mic2 = Number(mic2Draft);
    if (
      !Number.isInteger(mic1) ||
      !Number.isInteger(mic2) ||
      mic1 < 0 ||
      mic1 > 19 ||
      mic2 < 0 ||
      mic2 > 19
    ) {
      setMicError(true);
      return;
    }
    setMicError(false);
    if (await session.setMicGain(micMode, mic1, mic2)) setEditingMic(false);
  };

  const runConfirm = async () => {
    const action = confirm;
    setConfirm(null);
    if (!action) return;
    if (action === "unbind") await session.unbind(false);
    if (action === "factoryReset") await session.factoryReset();
    if (action === "formatStorage") await session.formatStorage();
  };

  const confirmText =
    confirm === "unbind"
      ? {
          title: t("recordingCard.unbind_confirm_title"),
          description: t("recordingCard.unbind_confirm_desc"),
          action: t("recordingCard.unbind_confirm_action"),
        }
      : confirm === "factoryReset"
        ? {
            title: t("recordingCard.factory_reset_confirm_title"),
            description: t("recordingCard.factory_reset_confirm_desc"),
            action: t("recordingCard.factory_reset_confirm_action"),
          }
        : {
            title: t("recordingCard.format_storage_confirm_title"),
            description: t("recordingCard.format_storage_confirm_desc", {
              count: session.files.length,
            }),
            action: t("recordingCard.format_storage_confirm_action"),
          };

  return (
    <div className="space-y-4">
      <Card className="gap-0 py-0 overflow-hidden">
        <CardContent className="space-y-4 p-5">
          {session.phase === "connected" ? (
            <>
              {/* Connected Hero Row */}
              <div className="flex items-center gap-4 sm:gap-5">
                <div className="relative flex shrink-0 items-center justify-center p-1">
                  <img
                    src="/spark-card.png"
                    alt="Lynse SparkCard"
                    className="h-24 sm:h-28 w-auto object-contain drop-shadow-[0_8px_16px_rgba(0,0,0,0.35)] transition-transform duration-300 hover:scale-105"
                  />
                </div>
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2.5">
                        <h2 className="text-base sm:text-lg font-semibold tracking-tight text-foreground">
                          {t("recordingCard.overview_title")}
                        </h2>
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-500">
                          <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          {t("recordingCard.status_connected")}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("recordingCard.overview_subtitle_connected")}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 shrink-0 px-2.5 text-xs text-muted-foreground hover:text-destructive"
                      onClick={session.disconnect}
                    >
                      {t("recordingCard.disconnect")}
                    </Button>
                  </div>

                  {/* Metadata Grid (SN + RTC Clock) */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-lg bg-muted/40 p-3">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">{t("recordingCard.device_sn")}</p>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className="truncate font-mono text-xs sm:text-sm font-medium text-foreground" title={serial}>
                          {serial || t("recordingCard.auto_off_unknown")}
                        </span>
                        {serial && (
                          <button
                            type="button"
                            onClick={copySerial}
                            className="inline-flex shrink-0 items-center justify-center text-muted-foreground hover:text-foreground transition-colors p-0.5"
                            title={t("recordingCard.copy_sn")}
                            aria-label={t("recordingCard.copy_sn")}
                          >
                            {copied ? (
                              <Check className="size-3.5 text-emerald-500" />
                            ) : (
                              <Copy className="size-3.5" />
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">{t("recordingCard.clock_status_title")}</p>
                      <div className="mt-1 flex items-center gap-2 text-xs sm:text-sm font-medium text-foreground">
                        <span
                          className={`size-2 rounded-full ${
                            session.clockSynced === false ? "bg-destructive" : "bg-emerald-500"
                          }`}
                          aria-hidden="true"
                        />
                        <span>{clockLabel}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Storage & Files Core Action Section */}
              <div className="rounded-lg bg-muted/30 p-4 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-2 font-medium text-foreground">
                    <HardDrive className="size-4 text-muted-foreground" />
                    {t("recordingCard.storage_title")}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {t("recordingCard.storage_used_of_total", {
                      used: formatBytes(storageUsedBytes),
                      total: formatBytes(storageTotalBytes),
                    })}{" "}
                    · {t("recordingCard.storage_free", { free: formatBytes(storageFreeBytes) })}
                  </span>
                </div>

                <div
                  className="h-2 w-full overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label={t("recordingCard.storage_used", {
                    used: formatBytes(storageUsedBytes),
                  })}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(storageUsedPercent)}
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300"
                    style={{
                      width: `${storageUsedPercent}%`,
                      minWidth: storageUsedBytes > 0 ? 6 : 0,
                    }}
                  />
                </div>

                <div className="flex items-center justify-between border-t border-border/40 pt-3">
                  <span className="text-xs text-muted-foreground">
                    {t("recordingCard.files_count", { count: session.files.length })}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 gap-1.5 px-3.5 text-xs font-medium shadow-sm"
                    onClick={onOpenFiles}
                  >
                    {t("recordingCard.storage_open")}
                    <ChevronRight className="size-3.5" />
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-4">
              <div className="relative flex shrink-0 items-center justify-center">
                <img
                  src="/spark-card.png"
                  alt="Lynse SparkCard"
                  className="h-16 w-auto object-contain opacity-50 grayscale drop-shadow-sm"
                />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-foreground">
                  {t("recordingCard.overview_title")}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("recordingCard.overview_subtitle")}
                </p>
              </div>
              <Button
                size="sm"
                className="h-8 shrink-0 px-3 text-xs"
                disabled={session.phase === "connecting"}
                onClick={session.connect}
              >
                {session.phase === "connecting" ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : null}
                {t("recordingCard.connect")}
              </Button>
            </div>
          )}

          {session.phase === "error" && (
            <p className="break-all text-xs text-destructive">
              {t("recordingCard.err_connect_failed", {
                message: errorKey ? t(errorKey) : session.errorMessage ?? "",
              })}
            </p>
          )}
        </CardContent>
      </Card>

      {session.phase === "connected" && (
        <>
          <Card className="gap-0 py-0 overflow-hidden">
            <CardContent className="p-0">
              <SectionHeading icon={Settings} label={t("recordingCard.settings_section")} />
              <SettingRow
                label={t("recordingCard.auto_off")}
                hint={
                  session.autoOffMinutes === null
                    ? t("recordingCard.auto_off_unknown")
                    : t("recordingCard.auto_off_hint", { minutes: session.autoOffMinutes })
                }
              >
                {editingAutoOff ? (
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="number"
                      min={1}
                      max={36000}
                      value={autoOffDraft}
                      onChange={(event) => {
                        setAutoOffDraft(event.target.value);
                        setAutoOffError(false);
                      }}
                      className="h-8 w-20 px-2.5 text-xs"
                      aria-label={t("recordingCard.auto_off")}
                    />
                    <span className="text-xs text-muted-foreground">{t("recordingCard.minutes_unit")}</span>
                    <Button
                      size="sm"
                      className="h-8 px-3 text-xs"
                      disabled={busy}
                      onClick={() => void saveAutoOff()}
                    >
                      {busy ? <Loader2 className="size-3 animate-spin" /> : null}
                      {t("recordingCard.save")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-3 text-xs"
                      onClick={() => setEditingAutoOff(false)}
                    >
                      {t("recordingCard.cancel")}
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1 px-3 text-xs"
                    onClick={() => setEditingAutoOff(true)}
                  >
                    {t("recordingCard.edit")}
                    <ChevronRight className="size-3.5 text-muted-foreground" />
                  </Button>
                )}
              </SettingRow>
              {autoOffError && (
                <p className="px-4 pb-2.5 text-xs text-destructive">
                  {t("recordingCard.invalid_minutes")}
                </p>
              )}

              <SettingRow
                label={t("recordingCard.mic_gain")}
                hint={
                  session.micGain
                    ? t("recordingCard.mic_gain_hint", {
                        mic1: session.micGain.mic1,
                        mic2: session.micGain.mic2,
                      })
                    : t("recordingCard.auto_off_unknown")
                }
              >
                {editingMic ? (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <div className="flex items-center rounded-md bg-muted p-0.5 text-xs">
                      <button
                        type="button"
                        className={`rounded px-2 py-1 ${
                          micMode === 0 ? "bg-background font-medium shadow-xs" : "text-muted-foreground"
                        }`}
                        onClick={() => setMicMode(0)}
                      >
                        {t("recordingCard.mic_mode_meeting")}
                      </button>
                      <button
                        type="button"
                        className={`rounded px-2 py-1 ${
                          micMode === 1 ? "bg-background font-medium shadow-xs" : "text-muted-foreground"
                        }`}
                        onClick={() => setMicMode(1)}
                      >
                        {t("recordingCard.mic_mode_call")}
                      </button>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">{t("recordingCard.mic1_label")}</span>
                      <Input
                        type="number"
                        min={0}
                        max={19}
                        value={mic1Draft}
                        onChange={(event) => {
                          setMic1Draft(event.target.value);
                          setMicError(false);
                        }}
                        className="h-8 w-14 px-1 text-center text-xs"
                        aria-label={t("recordingCard.mic1")}
                      />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">{t("recordingCard.mic2_label")}</span>
                      <Input
                        type="number"
                        min={0}
                        max={19}
                        value={mic2Draft}
                        onChange={(event) => {
                          setMic2Draft(event.target.value);
                          setMicError(false);
                        }}
                        className="h-8 w-14 px-1 text-center text-xs"
                        aria-label={t("recordingCard.mic2")}
                      />
                    </div>
                    <Button
                      size="sm"
                      className="h-8 px-3 text-xs"
                      disabled={busy}
                      onClick={() => void saveMicGain()}
                    >
                      {busy ? <Loader2 className="size-3 animate-spin" /> : null}
                      {t("recordingCard.save")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-3 text-xs"
                      onClick={() => setEditingMic(false)}
                    >
                      {t("recordingCard.cancel")}
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1 px-3 text-xs"
                    onClick={() => setEditingMic(true)}
                  >
                    {t("recordingCard.edit")}
                    <ChevronRight className="size-3.5 text-muted-foreground" />
                  </Button>
                )}
              </SettingRow>
              {micError && (
                <p className="px-4 pb-2.5 text-xs text-destructive">
                  {t("recordingCard.invalid_gain")}
                </p>
              )}

              <SettingRow label={t("recordingCard.bind_device")} hint={t("recordingCard.bind_hint")}>
                <div className="flex items-center gap-2.5">
                  <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                    {t("recordingCard.bind_status_bound")}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 px-3 text-xs text-muted-foreground hover:text-destructive"
                    disabled={busy}
                    onClick={() => setConfirm("unbind")}
                  >
                    {t("recordingCard.unbind_action")}
                  </Button>
                </div>
              </SettingRow>
            </CardContent>
          </Card>

          <Card className="gap-0 py-0 overflow-hidden">
            <CardContent className="p-0">
              <SectionHeading icon={Wrench} label={t("recordingCard.maintenance_section")} />
              <SettingRow
                label={t("recordingCard.factory_reset")}
                hint={t("recordingCard.factory_reset_hint")}
              >
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 text-xs"
                  disabled={busy}
                  onClick={() => setConfirm("factoryReset")}
                >
                  {t("recordingCard.factory_reset_action")}
                </Button>
              </SettingRow>
              <SettingRow
                label={t("recordingCard.format_storage")}
                hint={t("recordingCard.format_storage_hint")}
              >
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-8 px-3 text-xs"
                  disabled={busy}
                  onClick={() => setConfirm("formatStorage")}
                >
                  {t("recordingCard.format_storage_action")}
                </Button>
              </SettingRow>
            </CardContent>
          </Card>
        </>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmText.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmText.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm" className="h-8 text-xs">
              {t("recordingCard.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant={confirm === "formatStorage" ? "destructive" : "default"}
              className="h-8 text-xs"
              disabled={busy}
              onClick={() => void runConfirm()}
            >
              {busy ? <Loader2 className="size-3 animate-spin" /> : null}
              {confirmText.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SectionHeading({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border/50 bg-muted/15 px-4 py-3">
      <Icon className="size-4 text-muted-foreground" />
      <span className="text-xs font-semibold text-foreground/85">{label}</span>
    </div>
  );
}

function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/40 px-4 py-3.5 last:border-b-0">
      <div className="min-w-0 pr-2">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="mt-0.5 text-xs leading-normal text-muted-foreground">{hint}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
