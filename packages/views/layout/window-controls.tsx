"use client";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@lynse/ui/lib/utils";
import { useTranslation } from "@lynse/core/i18n/react";
import { Minus, Square, Copy, X } from "../icons";
import { isTauri, isMacDesktop, useMaximized } from "./use-maximized";

export const showWindowControls = isTauri && !isMacDesktop;

/**
 * Caption buttons for the frameless Windows/Linux window. Flush to the top-right
 * corner and full bar height, matching where the OS put them before: the close
 * target sits at the window edge, not inset by the app's own padding.
 *
 * Renders nothing on macOS (native traffic lights) and in the web build. The
 * login page mounts this in its own caption band with `allowMaximize: false` —
 * the welcome window keeps its normal look but the maximize button is a no-op.
 */
export function WindowControls({ allowMaximize = true }: { allowMaximize?: boolean }) {
  const { t } = useTranslation();
  const maximized = useMaximized();

  if (!showWindowControls) return null;

  return (
    <div
      className="flex h-full shrink-0 items-stretch self-stretch"
      data-tauri-drag-region={false}
    >
      <CaptionButton label={t("layout.window_minimize")} onClick={() => void getCurrentWindow().minimize()}>
        <Minus className="size-3.5" strokeWidth={1.5} />
      </CaptionButton>
      <CaptionButton
        label={t(maximized ? "layout.window_restore" : "layout.window_maximize")}
        onClick={allowMaximize ? () => void getCurrentWindow().toggleMaximize() : undefined}
      >
        {maximized ? (
          <Copy className="size-3.5" strokeWidth={1.5} />
        ) : (
          <Square className="size-3.5" strokeWidth={1.5} />
        )}
      </CaptionButton>
      <CaptionButton label={t("layout.window_close")} danger onClick={() => void getCurrentWindow().close()}>
        <X className="size-3.5" strokeWidth={1.5} />
      </CaptionButton>
    </div>
  );
}

function CaptionButton({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-tauri-drag-region={false}
      onClick={onClick}
      className={cn(
        "flex w-[46px] shrink-0 items-center justify-center transition-colors",
        danger
          ? "text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
