"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Label } from "@lynse/ui/components/ui/label";
import { useTranslation } from "@lynse/core/i18n/react";
import { getDesktopLiveTranslationApi } from "../live-translation/desktop-api";
import {
  readRecordingDeviceSelection,
  saveRecordingDeviceSelection,
} from "../live-translation/recording-devices";
import type { AudioDevicesSnapshot } from "../live-translation/types";

/** "Follow the OS default" sentinel option value. */
const FOLLOW_DEFAULT = "";

function deviceLabel(
  name: string,
  isDefault: boolean,
  isDefaultCommunications: boolean,
  t: (key: string) => string,
): string {
  const badges: string[] = [];
  if (isDefault) badges.push(t("live_translation.device_badge_default"));
  else if (isDefaultCommunications)
    badges.push(t("live_translation.device_badge_comms"));
  return badges.length > 0 ? `${name}（${badges.join(" · ")}）` : name;
}

/**
 * Recording device pickers (Windows). The system mixdown and the microphone
 * can each be pinned to a specific endpoint; the persisted value is the
 * stable WASAPI endpoint id, and "follow default" keeps tracking OS default
 * changes (including mid-recording). Renders nothing on platforms without
 * device enumeration (macOS/web) so the settings stay clean.
 */
export function RecordingDevicesCard() {
  const api = getDesktopLiveTranslationApi();
  const { t } = useTranslation();
  const [devices, setDevices] = useState<AudioDevicesSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [selection, setSelection] = useState(readRecordingDeviceSelection());

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .audioDevices()
      .then((snapshot) => {
        if (cancelled) return;
        setDevices(snapshot);
      })
      .catch(() => {
        if (cancelled) return;
        setDevices({ inputs: [], outputs: [], defaultInput: null, defaultOutput: null });
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (!api || !loaded || !devices) return null;
  // macOS/web: no enumeration → no pickers (capture follows OS defaults).
  if (devices.inputs.length === 0 && devices.outputs.length === 0) return null;

  function updateMic(value: string) {
    const next = { ...selection, micDeviceId: value || undefined };
    setSelection(next);
    saveRecordingDeviceSelection(next);
  }

  function updateSystem(value: string) {
    const next = { ...selection, systemDeviceId: value || undefined };
    setSelection(next);
    saveRecordingDeviceSelection(next);
  }

  const selectClass =
    "h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs">{t("live_translation.device_section")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="recording-mic-device" className="text-xs">
            {t("live_translation.device_mic")}
          </Label>
          <select
            id="recording-mic-device"
            value={selection.micDeviceId ?? FOLLOW_DEFAULT}
            onChange={(e) => updateMic(e.target.value)}
            className={selectClass}
          >
            <option value={FOLLOW_DEFAULT}>
              {t("live_translation.device_follow_default")}
            </option>
            {devices.inputs.map((device) => (
              <option key={device.id} value={device.id}>
                {deviceLabel(device.name, device.isDefault, device.isDefaultCommunications, t)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="recording-system-device" className="text-xs">
            {t("live_translation.device_system")}
          </Label>
          <select
            id="recording-system-device"
            value={selection.systemDeviceId ?? FOLLOW_DEFAULT}
            onChange={(e) => updateSystem(e.target.value)}
            className={selectClass}
          >
            <option value={FOLLOW_DEFAULT}>
              {t("live_translation.device_follow_default")}
            </option>
            {devices.outputs.map((device) => (
              <option key={device.id} value={device.id}>
                {deviceLabel(device.name, device.isDefault, device.isDefaultCommunications, t)}
              </option>
            ))}
          </select>
        </div>
        <p className="text-3xs leading-relaxed text-muted-foreground">
          {t("live_translation.device_hint")}
        </p>
      </CardContent>
    </Card>
  );
}
