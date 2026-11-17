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
  Usb,
  Wrench,
} from "../icons";
import type { RecordingCardMicMode, RecordingCardSessionView } from "./transport";

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
      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
              <Usb className="size-5 text-muted-foreground" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-medium">{t("recordingCard.overview_title")}</h2>
              <p className="text-2xs text-muted-foreground">
                {t("recordingCard.overview_subtitle")}
              </p>
            </div>
          </div>

          <div className="rounded-lg bg-muted/40 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-2">
                <div>
                  <p className="text-2xs text-muted-foreground">
                    {t("recordingCard.device_name")}
                  </p>
                  <p className="mt-0.5 truncate text-xs font-medium" title={session.deviceName ?? serial}>
                    {(session.deviceName ?? serial) || t("recordingCard.auto_off_unknown")}
                  </p>
                </div>
                <div>
                  <p className="text-2xs text-muted-foreground">
                    {t("recordingCard.device_sn")}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-xs" title={serial}>
                    {serial || t("recordingCard.auto_off_unknown")}
                  </p>
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 shrink-0 px-2 text-2xs"
                onClick={copySerial}
                disabled={!serial}
              >
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                {copied ? t("recordingCard.copied") : t("recordingCard.copy_sn")}
              </Button>
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-2xs text-muted-foreground">
              <span
                className={`size-1.5 rounded-full ${
                  session.clockSynced === false ? "bg-destructive" : "bg-primary"
                }`}
                aria-hidden="true"
              />
              {clockLabel}
            </div>
          </div>

          <button
            type="button"
            onClick={onOpenFiles}
            className="w-full rounded-lg border bg-background p-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-sm font-medium">
                <HardDrive className="size-4 text-muted-foreground" />
                {t("recordingCard.storage_title")}
              </span>
              <span className="flex items-center gap-1 text-2xs text-muted-foreground">
                {t("recordingCard.storage_open")}
                <ChevronRight className="size-3" />
              </span>
            </div>
            <p className="mt-2 text-2xs text-muted-foreground">
              {t("recordingCard.storage_total_used", {
                total: formatBytes(storageTotalBytes),
                used: formatBytes(storageUsedBytes),
              })}
            </p>
            <div
              className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-label={t("recordingCard.storage_used", {
                used: formatBytes(storageUsedBytes),
              })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(storageUsedPercent)}
            >
              <div
                className="h-full bg-primary transition-[width] duration-300"
                style={{
                  width: `${storageUsedPercent}%`,
                  minWidth: storageUsedBytes > 0 ? 2 : 0,
                }}
              />
            </div>
            <p className="mt-1 text-right text-2xs text-muted-foreground">
              {t("recordingCard.storage_free", { free: formatBytes(storageFreeBytes) })}
            </p>
          </button>
        </CardContent>
      </Card>

      <Card>
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
                  className="h-7 w-20 px-2 text-2xs"
                  aria-label={t("recordingCard.auto_off")}
                />
                <Button
                  size="sm"
                  className="h-7 px-2 text-2xs"
                  disabled={busy}
                  onClick={() => void saveAutoOff()}
                >
                  {busy ? <Loader2 className="size-3 animate-spin" /> : null}
                  {t("recordingCard.save")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-2xs"
                  onClick={() => setEditingAutoOff(false)}
                >
                  {t("recordingCard.cancel")}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-2xs"
                onClick={() => setEditingAutoOff(true)}
              >
                {t("recordingCard.edit")}
                <ChevronRight className="size-3" />
              </Button>
            )}
          </SettingRow>
          {autoOffError && (
            <p className="px-4 pb-2 text-2xs text-destructive">
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
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <div className="flex items-center rounded-md bg-muted p-0.5 text-2xs">
                  <button
                    type="button"
                    className={`rounded px-1.5 py-1 ${
                      micMode === 0 ? "bg-background font-medium" : "text-muted-foreground"
                    }`}
                    onClick={() => setMicMode(0)}
                  >
                    {t("recordingCard.mic_mode_meeting")}
                  </button>
                  <button
                    type="button"
                    className={`rounded px-1.5 py-1 ${
                      micMode === 1 ? "bg-background font-medium" : "text-muted-foreground"
                    }`}
                    onClick={() => setMicMode(1)}
                  >
                    {t("recordingCard.mic_mode_call")}
                  </button>
                </div>
                <Input
                  type="number"
                  min={0}
                  max={19}
                  value={mic1Draft}
                  onChange={(event) => {
                    setMic1Draft(event.target.value);
                    setMicError(false);
                  }}
                  className="h-7 w-14 px-2 text-2xs"
                  aria-label={t("recordingCard.mic1")}
                />
                <Input
                  type="number"
                  min={0}
                  max={19}
                  value={mic2Draft}
                  onChange={(event) => {
                    setMic2Draft(event.target.value);
                    setMicError(false);
                  }}
                  className="h-7 w-14 px-2 text-2xs"
                  aria-label={t("recordingCard.mic2")}
                />
                <Button
                  size="sm"
                  className="h-7 px-2 text-2xs"
                  disabled={busy}
                  onClick={() => void saveMicGain()}
                >
                  {busy ? <Loader2 className="size-3 animate-spin" /> : null}
                  {t("recordingCard.save")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-2xs"
                  onClick={() => setEditingMic(false)}
                >
                  {t("recordingCard.cancel")}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-2xs"
                onClick={() => setEditingMic(true)}
              >
                {t("recordingCard.edit")}
                <ChevronRight className="size-3" />
              </Button>
            )}
          </SettingRow>
          {micError && (
            <p className="px-4 pb-2 text-2xs text-destructive">
              {t("recordingCard.invalid_gain")}
            </p>
          )}

          <SettingRow label={t("recordingCard.bind_device")} hint={t("recordingCard.bind_hint")}>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-2xs"
              disabled={busy}
              onClick={() => void session.setBound(true)}
            >
              {t("recordingCard.bind_action")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-2xs"
              disabled={busy}
              onClick={() => setConfirm("unbind")}
            >
              {t("recordingCard.unbind_action")}
            </Button>
          </SettingRow>

          <SettingRow
            label={t("recordingCard.disconnect_device")}
            hint={t("recordingCard.disconnect_hint")}
          >
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-2xs"
              onClick={() => session.setAccess(false)}
            >
              <ChevronRight className="size-3" />
            </Button>
          </SettingRow>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <SectionHeading icon={Wrench} label={t("recordingCard.maintenance_section")} />
          <SettingRow
            label={t("recordingCard.factory_reset")}
            hint={t("recordingCard.factory_reset_hint")}
          >
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-2xs"
              disabled={busy}
              onClick={() => setConfirm("factoryReset")}
            >
              <ChevronRight className="size-3" />
            </Button>
          </SettingRow>
          <SettingRow
            label={t("recordingCard.format_storage")}
            hint={t("recordingCard.format_storage_hint")}
          >
            <Button
              size="sm"
              variant="destructive"
              className="h-7 px-2 text-2xs"
              disabled={busy}
              onClick={() => setConfirm("formatStorage")}
            >
              <ChevronRight className="size-3" />
            </Button>
          </SettingRow>
        </CardContent>
      </Card>

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

function SectionHeading({ icon: Icon, label }: { icon: typeof Usb; label: string }) {
  return (
    <div className="flex items-center gap-2 border-b px-4 py-2.5">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="text-xs font-medium">{label}</span>
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
    <div className="flex items-start justify-between gap-3 border-b px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="text-xs font-medium">{label}</p>
        <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{children}</div>
    </div>
  );
}
