import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { WAITING_POOL } from "./use-chat";

type Lang = "zh" | "en" | "ja";

function pickLang(lang: string): Lang {
  return lang === "en" ? "en" : lang === "ja" ? "ja" : "zh";
}

/**
 * Resolve a stored status (a tool key, "__unknown__", or raw text) into the
 * pool of waiting-word phrases to rotate through. A known tool key yields its
 * scene-flavoured pool; unknown raw text is shown statically as a single
 * phrase so the component still works uniformly.
 */
function resolvePhrases(status: string | undefined): { zh: string; en: string; ja: string }[] {
  if (!status) return [];
  const pool = WAITING_POOL[status];
  if (pool) return pool;
  return [{ zh: status, en: status, ja: status }];
}

/**
 * Rotate through the waiting words while a tool call runs, so the wait feels
 * alive instead of a frozen line. Picked by UI locale, falls back to zh.
 */
export function useRotatingWaiting(status: string | undefined): string {
  const { i18n } = useTranslation();
  const lang = pickLang(i18n.language?.split("-")[0] ?? "zh");
  const phrases = useMemo(() => resolvePhrases(status), [status]);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
    if (phrases.length <= 1) return;
    const id = setInterval(() => {
      setIndex((prev) => (prev + 1) % phrases.length);
    }, 1800);
    return () => clearInterval(id);
  }, [phrases]);

  const phrase = phrases[index] ?? phrases[0];
  return phrase ? phrase[lang] : "";
}

export function WaitingText({
  status,
  className,
}: {
  status?: string;
  className?: string;
}) {
  const text = useRotatingWaiting(status);
  return <span className={className}>{text}</span>;
}
