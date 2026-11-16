"use client";

import { useEffect, useState } from "react";

// Browser package without @types/node; declared the same way as
// about-content.tsx. Next inlines the NEXT_PUBLIC member expression at build
// time, and the desktop (Vite) runtime never has `process` at all.
declare const process: { env: Record<string, string | undefined> } | undefined;

export interface AssistantAvatarDef {
  /** Stable identifier, also used as the persistence key value. */
  id: string;
  /** i18n key under the `chat` namespace, e.g. "avatar_default". */
  i18nKey: string;
  /** Public asset path to the (animated) GIF. */
  src: string;
}

/**
 * Public asset URLs must respect the web deployment's base path — the web app
 * serves under e.g. https://www.lynse.cn/app/, and a raw root-relative <img>
 * src would bypass that prefix and 404. Next inlines the literal NEXT_PUBLIC
 * member expression at build time; the desktop (Vite) runtime has no
 * `process`, so the typeof guard keeps root-relative paths there (same idiom
 * as about-content.tsx).
 */
export function publicAssetUrl(path: string): string {
  const base = (typeof process !== "undefined" && process.env.NEXT_PUBLIC_BASE_PATH) || "";
  return `${base}${path}`;
}

/**
 * The Lynse desktop AI assistant IP images. Each entry is one of the mascot
 * GIFs shipped in `apps/tauri/public/assistant/`. The first entry is the
 * default appearance.
 */
export const ASSISTANT_AVATARS: AssistantAvatarDef[] = [
  { id: "default", i18nKey: "avatar_default", src: publicAssetUrl("/assistant/default.gif") },
  { id: "star-hat", i18nKey: "avatar_star_hat", src: publicAssetUrl("/assistant/star-hat.gif") },
  { id: "gentleman-hat", i18nKey: "avatar_gentleman_hat", src: publicAssetUrl("/assistant/gentleman-hat.gif") },
  { id: "bow", i18nKey: "avatar_bow", src: publicAssetUrl("/assistant/bow.gif") },
  { id: "beret", i18nKey: "avatar_beret", src: publicAssetUrl("/assistant/beret.gif") },
];

const FALLBACK = ASSISTANT_AVATARS[0]!;
const STORAGE_KEY = "lynse.assistant.avatar.id";

type Listener = () => void;
const listeners = new Set<Listener>();

function readStoredId(): string {
  if (typeof window === "undefined") return FALLBACK.id;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && ASSISTANT_AVATARS.some((a) => a.id === stored)) return stored;
  return FALLBACK.id;
}

let currentId = readStoredId();

function persist(id: string) {
  currentId = id;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, id);
  }
  listeners.forEach((fn) => fn());
}

export function getAssistantAvatar(): AssistantAvatarDef {
  return ASSISTANT_AVATARS.find((a) => a.id === currentId) ?? FALLBACK;
}

/** Advance to the next IP appearance (wraps around) and persist the choice. */
export function cycleAssistantAvatar(): AssistantAvatarDef {
  const idx = ASSISTANT_AVATARS.findIndex((a) => a.id === currentId);
  const next = ASSISTANT_AVATARS[(idx + 1) % ASSISTANT_AVATARS.length] ?? FALLBACK;
  persist(next.id);
  return next;
}

/** Live, cross-panel reactive hook for the currently selected IP appearance. */
export function useAssistantAvatar() {
  const [avatar, setAvatar] = useState<AssistantAvatarDef>(getAssistantAvatar);

  useEffect(() => {
    const sync = () => setAvatar(getAssistantAvatar());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) sync();
    };
    listeners.add(sync);
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return { avatar, cycle: cycleAssistantAvatar };
}
