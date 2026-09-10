"use client";

import { useEffect, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@lynse/ui/components/ui/card";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { Switch } from "@lynse/ui/components/ui/switch";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  KNOWN_MEETING_APPS,
  getDesktopMeetingDetectorApi,
  loadMeetingAutoRecordConfig,
  saveMeetingAutoRecordConfig,
  toDetectorConfigPayload,
  type DetectorStatus,
  type MeetingAppEntry,
} from "../live-translation";
import { featureFlags } from "../feature-flags";

/** Selectable start-debounce values (signal persistence before a meeting is
 * confirmed). Longer = fewer false starts, later recording onset. */
const DEBOUNCE_OPTIONS = [10, 15, 30, 60] as const;
/** Selectable end-grace values (silence tolerated before a meeting ends). */
const GRACE_OPTIONS = [30, 60, 90, 120] as const;

/** Identifiers split on commas/semicolons; anything containing a dot is
 * treated as a bundle ID (macOS), the rest as an executable name (Windows and
 * unbundled helpers). */
function parseCustomIdentifiers(raw: string): { bundleIds: string[]; processNames: string[] } {
  const parts = raw
    .split(/[,;，；]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return {
    bundleIds: parts.filter((part) => part.includes(".")),
    processNames: parts.filter((part) => !part.includes(".")),
  };
}

/**
 * Settings card for auto-recording detected meetings. Config lives in
 * localStorage and is mirrored into the Rust detector (`meetingDetector.
 * setConfig`) on every change; enabling the feature only flips detection on —
 * permissions are pre-checked inline (never prompted silently) so the first
 * meeting is not interrupted by a TCC dialog.
 */
export function AutoRecordConfigCard() {
  const { t } = useTranslation();
  const detectorApi = getDesktopMeetingDetectorApi();
  const [config, setConfig] = useState(() => loadMeetingAutoRecordConfig());
  const [status, setStatus] = useState<DetectorStatus | null>(null);
  const [permissionHint, setPermissionHint] = useState<string | null>(null);
  const [customName, setCustomName] = useState("");
  const [customIdentifier, setCustomIdentifier] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Persisted config may have been written by a previous session; mirror the
  // fresh one into the detector and pick up its current phase.
  useEffect(() => {
    if (!detectorApi) return;
    let cancelled = false;
    void detectorApi
      .setConfig(toDetectorConfigPayload(loadMeetingAutoRecordConfig(), (key) => t(key)))
      .catch(() => undefined);
    void detectorApi
      .getState()
      .then((state) => {
        if (!cancelled) setStatus(state);
      })
      .catch(() => undefined);
    void detectorApi
      .onEvent(() => {
        void detectorApi
          .getState()
          .then((state) => {
            if (!cancelled) setStatus(state);
          })
          .catch(() => undefined);
      })
      .then((unsub) => {
        if (cancelled) unsub();
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectorApi]);

  if (!detectorApi || !featureFlags.autoRecord) return null;

  function persist(next: typeof config) {
    setConfig(next);
    saveMeetingAutoRecordConfig(next);
    void detectorApi
      ?.setConfig(toDetectorConfigPayload(next, (key) => t(key)))
      .then((state) => setStatus(state))
      .catch(() => undefined);
  }

  async function handleEnabledChange(enabled: boolean) {
    persist({ ...config, enabled });
    if (!enabled) {
      setPermissionHint(null);
      return;
    }
    // Pre-check (never prompt) so the first auto-recorded meeting does not
    // open a TCC dialog in the middle of the call.
    try {
      const api = (window as Window & {
        desktopAPI?: { liveTranslation?: { permissions: () => Promise<{ microphone: string; systemAudio: string; systemAudioRequired: boolean; restartRequired: boolean }> } };
      }).desktopAPI?.liveTranslation;
      const perms = await api?.permissions();
      if (!perms) return;
      if (perms.restartRequired) {
        setPermissionHint(t("auto_record.permission_restart"));
      } else if (perms.microphone !== "granted") {
        setPermissionHint(t("auto_record.permission_missing_mic"));
      } else if (perms.systemAudioRequired && perms.systemAudio !== "granted") {
        setPermissionHint(t("auto_record.permission_missing_system"));
      } else {
        setPermissionHint(null);
      }
    } catch {
      /* status unknown — leave the hint empty */
    }
  }

  function toggleApp(id: string, enabled: boolean) {
    const appIds = enabled
      ? [...new Set([...config.appIds, id])]
      : config.appIds.filter((candidate) => candidate !== id);
    persist({ ...config, appIds });
  }

  function addCustomApp() {
    if (!customName.trim() || !customIdentifier.trim()) return;
    const { bundleIds, processNames } = parseCustomIdentifiers(customIdentifier);
    if (bundleIds.length === 0 && processNames.length === 0) return;
    const entry: MeetingAppEntry = {
      id: `custom:${crypto.randomUUID()}`,
      name: customName.trim(),
      bundleIds,
      processNames,
    };
    persist({ ...config, customApps: [...config.customApps, entry] });
    setCustomName("");
    setCustomIdentifier("");
  }

  function removeCustomApp(id: string) {
    persist({ ...config, customApps: config.customApps.filter((app) => app.id !== id) });
  }

  const statusLabel = !config.enabled
    ? null
    : status?.phase === "in_meeting"
      ? t("auto_record.detector_in_meeting")
      : status?.phase === "starting"
        ? t("auto_record.detector_starting")
        : t("auto_record.detector_idle");

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs">{t("auto_record.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="auto-record-enabled" className="text-xs">
            {t("auto_record.enable")}
          </Label>
          <Switch
            id="auto-record-enabled"
            checked={config.enabled}
            onCheckedChange={handleEnabledChange}
          />
        </div>
        <p className="text-2xs leading-relaxed text-muted-foreground">
          {t("auto_record.hint")}
        </p>
        {statusLabel && (
          <p className="text-2xs text-muted-foreground">
            {t("auto_record.detector_status", { status: statusLabel })}
          </p>
        )}
        {permissionHint && (
          <p className="rounded-md border border-warning/40 bg-warning/10 p-2.5 text-2xs leading-relaxed text-warning-text">
            {permissionHint}
          </p>
        )}

        <div className="space-y-1.5">
          <Label className="text-2xs">{t("auto_record.apps")}</Label>
          <div className="space-y-1 rounded-md border bg-muted/30 p-2.5">
            {KNOWN_MEETING_APPS.map((app) => (
              <div key={app.id} className="flex items-center justify-between gap-3 py-0.5">
                <span className="text-xs">{t(app.name)}</span>
                <Switch
                  id={`auto-record-app-${app.id}`}
                  checked={config.appIds.includes(app.id)}
                  onCheckedChange={(checked) => toggleApp(app.id, checked)}
                />
              </div>
            ))}
            {config.customApps.length > 0 && (
              <div className="space-y-1 border-t pt-1.5">
                {config.customApps.map((app) => (
                  <div key={app.id} className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs">{app.name}</span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-6 px-2 text-xs"
                      onClick={() => removeCustomApp(app.id)}
                    >
                      {t("settings.delete")}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-2xs">{t("auto_record.custom_apps")}</Label>
          <Input
            value={customName}
            onChange={(event) => setCustomName(event.target.value)}
            placeholder={t("auto_record.custom_app_name")}
            className="h-8 text-xs"
          />
          <Input
            value={customIdentifier}
            onChange={(event) => setCustomIdentifier(event.target.value)}
            placeholder={t("auto_record.custom_app_identifier")}
            className="h-8 text-xs"
          />
          <Button
            type="button"
            size="sm"
            className="h-7 text-xs"
            onClick={addCustomApp}
            disabled={!customName.trim() || !customIdentifier.trim()}
          >
            {t("auto_record.add_custom_app")}
          </Button>
        </div>

        <div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-2xs text-muted-foreground"
            onClick={() => setShowAdvanced((visible) => !visible)}
          >
            {showAdvanced ? t("auto_record.advanced_hide") : t("auto_record.advanced")}
          </Button>
          {showAdvanced && (
            <div className="mt-1.5 grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="auto-record-debounce" className="text-2xs">
                  {t("auto_record.start_debounce")}
                </Label>
                <select
                  id="auto-record-debounce"
                  value={String(config.startDebounceSecs)}
                  onChange={(event) =>
                    persist({ ...config, startDebounceSecs: Number(event.target.value) })
                  }
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary"
                >
                  {DEBOUNCE_OPTIONS.map((secs) => (
                    <option key={secs} value={secs}>
                      {secs} {t("auto_record.seconds")}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="auto-record-grace" className="text-2xs">
                  {t("auto_record.end_grace")}
                </Label>
                <select
                  id="auto-record-grace"
                  value={String(config.endGraceSecs)}
                  onChange={(event) =>
                    persist({ ...config, endGraceSecs: Number(event.target.value) })
                  }
                  className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary"
                >
                  {GRACE_OPTIONS.map((secs) => (
                    <option key={secs} value={secs}>
                      {secs} {t("auto_record.seconds")}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
