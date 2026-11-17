"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Input } from "@lynse/ui/components/ui/input";
import { Switch } from "@lynse/ui/components/ui/switch";
import { Loader2, Usb } from "../icons";
import { DEFAULT_PRODUCT_ID, DEFAULT_VENDOR_ID } from "./credentials";
import { DeviceFiles } from "./device-files";
import { DeviceOverview } from "./device-overview";
import type { RecordingCardSessionView } from "./transport";

/** Parse "0x3654" or "13908" into a number; null when not a usable integer. */
function parseDescriptor(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^(0[xX][0-9a-fA-F]+|\d+)$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

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

const VID_STORAGE_KEY = "lynse_recording_card_vid";
const PID_STORAGE_KEY = "lynse_recording_card_pid";

function savedDescriptor(key: string, fallback: number): string {
  try {
    const saved = window.localStorage.getItem(key);
    return saved && parseDescriptor(saved) !== null ? saved : `0x${fallback.toString(16)}`;
  } catch {
    return `0x${fallback.toString(16)}`;
  }
}

/**
 * The recording-card USB management view. Rendered by the standalone web
 * route inside an AuthGate and by the desktop page inside the app shell. The
 * card's USB link never goes through Lynse servers except the firmware
 * password fetched after sign-in.
 */
export function RecordingCardManager({ session }: { session: RecordingCardSessionView }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"overview" | "files">("overview");
  // USB descriptor pair: prefilled with the reference hardware defaults,
  // editable for other card models. Persisted so a model tweak survives a
  // reload; the server config only supplies the initial password.
  const [vendorIdRaw, setVendorIdRaw] = useState(() => savedDescriptor(VID_STORAGE_KEY, DEFAULT_VENDOR_ID));
  const [productIdRaw, setProductIdRaw] = useState(() => savedDescriptor(PID_STORAGE_KEY, DEFAULT_PRODUCT_ID));
  const vendorId = parseDescriptor(vendorIdRaw);
  const productId = parseDescriptor(productIdRaw);
  const descriptorValid = vendorId !== null && productId !== null;

  useEffect(() => {
    if (session.phase !== "connected") setView("overview");
  }, [session.phase]);

  const handleDescriptorChange = (key: string, raw: string, setter: (value: string) => void) => {
    setter(raw);
    if (parseDescriptor(raw) !== null) {
      try {
        window.localStorage.setItem(key, raw.trim());
      } catch {
        // Persistence is a convenience; ignore storage failures.
      }
    }
  };

  const copyLink = () => {
    void navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const connect = () => {
    if (vendorId === null || productId === null) return;
    session.connect({ vendorId, productId });
  };

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

              {session.usbEnabled && (
                <div className="space-y-1.5">
                  <div className="flex items-center gap-3">
                    <label className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
                      <span>Vendor ID</span>
                      <Input
                        value={vendorIdRaw}
                        onChange={(e) => handleDescriptorChange(VID_STORAGE_KEY, e.target.value, setVendorIdRaw)}
                        className="h-7 w-24 px-2 font-mono text-2xs"
                        spellCheck={false}
                        aria-label="Vendor ID"
                      />
                    </label>
                    <label className="flex shrink-0 items-center gap-1.5 text-2xs text-muted-foreground">
                      <span>Product ID</span>
                      <Input
                        value={productIdRaw}
                        onChange={(e) => handleDescriptorChange(PID_STORAGE_KEY, e.target.value, setProductIdRaw)}
                        className="h-7 w-24 px-2 font-mono text-2xs"
                        spellCheck={false}
                        aria-label="Product ID"
                      />
                    </label>
                    <span className="min-w-0 truncate text-2xs text-muted-foreground">
                      {t("recordingCard.descriptor_hint")}
                    </span>
                  </div>
                  {!descriptorValid && (
                    <p className="text-2xs text-destructive">{t("recordingCard.descriptor_invalid")}</p>
                  )}
                </div>
              )}

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
                {session.phase !== "connected" && session.usbEnabled && (
                  <Button
                    size="sm"
                    className="h-7 shrink-0 text-xs"
                    disabled={!descriptorValid || session.phase === "connecting"}
                    onClick={connect}
                  >
                    {session.phase === "error"
                      ? t("recordingCard.retry")
                      : t("recordingCard.connect")}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {session.phase === "connected" && (
            <>
              {session.actionError && (
                <p className="break-all rounded-md bg-destructive/10 px-2.5 py-1.5 text-2xs text-destructive">
                  {t("recordingCard.action_failed", { message: session.actionError })}
                </p>
              )}
              {view === "overview" ? (
                <DeviceOverview
                  session={session}
                  onOpenFiles={() => setView("files")}
                  formatBytes={formatBytes}
                />
              ) : (
                <DeviceFiles
                  session={session}
                  onBack={() => setView("overview")}
                  formatBytes={formatBytes}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
