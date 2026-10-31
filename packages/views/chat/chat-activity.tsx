"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { ActivityIndicator, ActivityLabel } from "@lynse/ui/components/ui/activity-indicator";
import { cn } from "@lynse/ui/lib/utils";
import { WaitingText } from "../workspace/hooks/waiting-text";

/** Shared waiting presentation for the chat page and the meeting side panel. */
export function ChatActivity({
  status,
  startedAt,
  className,
}: {
  status?: string;
  startedAt?: number;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <span className={cn("flex min-h-6 items-center gap-2 text-muted-foreground", className)}>
      <ActivityIndicator />
      {status ? (
        <WaitingText status={status} startedAt={startedAt} />
      ) : (
        <span role="status"><ActivityLabel text={t("chat.thinking_active")} /></span>
      )}
    </span>
  );
}
