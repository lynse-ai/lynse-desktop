"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { DeviceFiles } from "./device-files";
import { DeviceOverview } from "./device-overview";
import type { RecordingCardSessionView } from "./transport";

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

  useEffect(() => {
    if (session.phase !== "connected") setView("overview");
  }, [session.phase]);

  const copyLink = () => {
    void navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4">
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
    </div>
  );
}
