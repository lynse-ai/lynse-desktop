"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { useAssistantAvatar } from "./assistant-avatar";

interface AssistantAvatarProps {
  /** Rendered diameter in pixels. */
  size?: number;
  className?: string;
  /** When true the avatar is a button that swaps to the next IP on click. */
  interactive?: boolean;
}

/**
 * The Lynse AI assistant IP image. Renders the currently selected mascot GIF
 * inside a circular, transparent-background frame. Clicking (when interactive)
 * cycles to the next appearance; the choice is persisted and shared across all
 * chat surfaces via {@link useAssistantAvatar}.
 */
export function AssistantAvatar({ size = 28, className, interactive = true }: AssistantAvatarProps) {
  const { t } = useTranslation();
  const { avatar, cycle } = useAssistantAvatar();

  const label = t(`chat.${avatar.i18nKey}`);
  const tip = `${t("chat.switch_avatar")} · ${label}`;

  return (
    <button
      type="button"
      onClick={interactive ? cycle : undefined}
      title={tip}
      aria-label={tip}
      draggable={false}
      className={[
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
        interactive ? "cursor-pointer transition-transform hover:scale-105 hover:ring-2 hover:ring-primary/40 active:scale-95" : "cursor-default",
        className ?? "",
      ].join(" ")}
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={avatar.id}
        src={avatar.src}
        alt={label}
        draggable={false}
        className="size-full select-none object-cover animate-avatar-in"
      />
    </button>
  );
}
