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
 * The Lynse AI assistant IP image. It floats directly on the current surface
 * without a shape container. Clicking it cycles to the next appearance and
 * keeps the choice shared across all chat surfaces.
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
        "relative inline-flex shrink-0 items-center justify-center bg-transparent drop-shadow-[0_12px_24px_rgba(0,0,0,0.28)] dark:brightness-[0.82] dark:contrast-[0.96] dark:saturate-[1.12]",
        interactive ? "cursor-pointer transition-transform hover:-translate-y-0.5 hover:scale-105 active:scale-95" : "cursor-default",
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
        className="size-full select-none object-contain animate-avatar-in"
      />
    </button>
  );
}
