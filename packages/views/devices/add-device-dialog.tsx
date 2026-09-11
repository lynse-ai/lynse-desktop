"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  Bluetooth,
  Loader2,
  RefreshCw,
  Signal,
} from "../icons";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import type { DiscoveredCardDevice, RecordingCardEvent } from "./types";
import { getRecordingCardApi } from "./desktop-api";

interface AddDeviceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  manufacturerCodeSet: boolean;
  onConnected: () => Promise<void>;
}

export function AddDeviceDialog({
  open,
  onOpenChange,
  manufacturerCodeSet,
  onConnected,
}: AddDeviceDialogProps) {
  const { t } = useTranslation();
  const api = getRecordingCardApi();
  const [code, setCode] = useState("");
  const [codeSaved, setCodeSaved] = useState(manufacturerCodeSet);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<DiscoveredCardDevice[]>([]);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const seenDevices = useRef(new Set<string>());

  // Restart scanning every time the dialog opens.
  useEffect(() => {
    if (!open || !api) return;
    seenDevices.current.clear();
    setDevices([]);
    let cancelled = false;
    const start = async () => {
      try {
        await api.scanStart();
        if (!cancelled) setScanning(true);
      } catch (error) {
        toast.error(String(error));
      }
    };
    void start();
    return () => {
      cancelled = true;
      void api.scanStop().catch(() => undefined);
      setScanning(false);
    };
  }, [open, api]);

  useEffect(() => {
    if (!open || !api) return;
    let dispose: (() => void) | undefined;
    void api.onEvent((event: RecordingCardEvent) => {
      if (event.type === "scan") {
        if (!seenDevices.current.has(event.device.id)) {
          seenDevices.current.add(event.device.id);
          setDevices((previous) =>
            [...previous, event.device].sort(
              (left, right) => (right.rssi ?? -200) - (left.rssi ?? -200),
            ),
          );
        }
      } else if (event.type === "scan-state") {
        setScanning(event.scanning);
      }
    }).then((disposeFn: () => void) => {
      dispose = disposeFn;
    });
    return () => dispose?.();
  }, [open, api]);

  const saveCode = useCallback(async () => {
    if (!api || code.trim().length === 0) return;
    try {
      await api.setManufacturerCode(code.trim());
      setCodeSaved(true);
      toast.success(t("devices.code_saved"));
    } catch (error) {
      toast.error(String(error));
    }
  }, [api, code, t]);

  const connect = async (device: DiscoveredCardDevice) => {
    if (!api) return;
    if (!codeSaved && !manufacturerCodeSet) {
      toast.error(t("devices.code_required"));
      return;
    }
    setConnectingId(device.id);
    try {
      await api.connect(device);
      await onConnected();
    } catch (error) {
      toast.error(String(error));
    } finally {
      setConnectingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 p-0">
        <DialogHeader className="border-b border-border/50 px-5 py-4">
          <DialogTitle className="text-sm">{t("devices.add_device")}</DialogTitle>
          <DialogDescription className="text-2xs">
            {t("devices.add_device_hint")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-5 py-4">
          {/* Manufacturer code */}
          <div>
            <label className="mb-1.5 block text-2xs font-medium text-foreground">
              {t("devices.manufacturer_code")}
            </label>
            <div className="flex gap-2">
              <Input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder={t("devices.manufacturer_code_placeholder")}
                className="h-8 flex-1 rounded-lg border-border bg-card text-xs shadow-sm"
              />
              <Button
                size="sm"
                variant="outline"
                className="h-8 shrink-0 text-xs"
                disabled={code.trim().length === 0}
                onClick={() => void saveCode()}
              >
                {t("devices.save_code")}
              </Button>
            </div>
            <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
              {codeSaved || manufacturerCodeSet
                ? t("devices.code_saved_hint")
                : t("devices.code_hint")}
            </p>
          </div>

          {/* Scan list */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-2xs font-medium text-foreground">
                {t("devices.nearby")}
              </span>
              {scanning ? (
                <span className="flex items-center gap-1 text-2xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  {t("devices.scanning")}
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-2 text-2xs text-muted-foreground"
                  onClick={async () => {
                    if (!api) return;
                    try {
                      seenDevices.current.clear();
                      setDevices([]);
                      await api.scanStart();
                      setScanning(true);
                    } catch (error) {
                      toast.error(String(error));
                    }
                  }}
                >
                  <RefreshCw className="size-3" />
                  {t("devices.rescan")}
                </Button>
              )}
            </div>

            {devices.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/60 py-8">
                <Bluetooth className="size-6 text-muted-foreground/40" />
                <p className="text-2xs text-muted-foreground">
                  {scanning ? t("devices.scanning_hint") : t("devices.no_devices")}
                </p>
              </div>
            ) : (
              <ul className="flex max-h-64 flex-col divide-y divide-border/40 overflow-y-auto rounded-lg border border-border/50">
                {devices.map((device) => (
                  <li
                    key={device.id}
                    className="flex items-center gap-3 px-3 py-2.5"
                  >
                    <Bluetooth className="size-4 shrink-0 text-primary/70" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-foreground">
                        {device.name}
                      </p>
                      <p className="flex items-center gap-2 text-2xs text-muted-foreground">
                        <span className="flex items-center gap-0.5">
                          <Signal className="size-3" />
                          {device.rssi ?? "—"}
                        </span>
                        {device.sku && <span>{device.sku}</span>}
                        <span>v{device.protocolVersion}</span>
                      </p>
                    </div>
                    <Button
                      size="sm"
                      className="h-7 shrink-0 px-3 text-xs"
                      disabled={connectingId !== null}
                      onClick={() => void connect(device)}
                    >
                      {connectingId === device.id ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        t("devices.connect")
                      )}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
