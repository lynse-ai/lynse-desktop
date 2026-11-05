"use client";

import { ActivityIndicator } from "@lynse/ui/components/ui/activity-indicator";
import { Button } from "@lynse/ui/components/ui/button";
import { cn } from "@lynse/ui/lib/utils";
import { RefreshCw } from "../icons";

export interface TaskRecoveryAction {
  label: string;
  onAction: () => void;
  busy?: boolean;
  disabled?: boolean;
}

/** Stable task feedback shared by summary and transcription states. */
export function TaskState({
  title,
  description,
  pending = false,
  action,
  className,
}: {
  title: string;
  description: string;
  pending?: boolean;
  action?: TaskRecoveryAction;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-[320px] flex-1 flex-col items-center justify-center gap-3 px-4 py-10 text-center", className)}>
      <div role={pending ? "status" : "alert"} className="flex w-full max-w-md flex-col items-center gap-3">
        {pending && (
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <ActivityIndicator className="size-5" />
          </span>
        )}
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
      </div>
      {action && (
        <Button
          type="button"
          variant="contrast"
          size="lg"
          onClick={action.onAction}
          disabled={action.busy || action.disabled}
          aria-busy={action.busy || undefined}
          className="mt-2 gap-2 px-6"
        >
          {action.busy ? <ActivityIndicator className="size-4" /> : <RefreshCw className="size-4" />}
          <span>{action.label}</span>
        </Button>
      )}
    </div>
  );
}
