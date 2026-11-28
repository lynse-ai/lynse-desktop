import { useState, type MouseEvent } from "react";
import { toast } from "sonner";
import { useTranslation } from "@lynse/core/i18n/react";
import { Check, Copy, Headphones, Mail } from "../icons";
import type { ChatHumanSupportLink } from "../workspace/types";

/**
 * Render an assistant human-support link. `mailto:` links open via the OS mail
 * handler (never `target="_blank"`, which leaves an `about:blank` tab) and
 * offer one-click copy plus automatic clipboard fallback when no mail app is
 * configured on desktop.
 */
export function ChatHumanSupportCard({
  link,
  revealed = false,
  compact = false,
}: {
  link?: ChatHumanSupportLink | null;
  revealed?: boolean;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const url = link?.url?.trim();
  if (!url) return null;

  const isMailto = /^mailto:/i.test(url);
  const emailAddress = isMailto ? (url.slice("mailto:".length).split("?")[0]?.trim() ?? "") : "";
  const label = isMailto
    ? emailAddress || link?.label?.trim() || t("chat.contact_support")
    : link?.label?.trim() || t("chat.contact_support");

  const revealClass = revealed ? "animate-in fade-in duration-300 delay-[350ms] fill-mode-backwards" : "";

  const copyAddress = async (silent = false): Promise<boolean> => {
    if (!emailAddress || !navigator.clipboard?.writeText) return false;
    try {
      await navigator.clipboard.writeText(emailAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      if (!silent) toast.success(t("chat.copied"));
      return true;
    } catch {
      return false;
    }
  };

  const handleMailClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const desktop = (window as Window & {
      desktopAPI?: { openExternal?: (targetUrl: string) => Promise<void> };
    }).desktopAPI;
    if (!desktop?.openExternal) return;
    event.preventDefault();
    void desktop.openExternal(url).catch(async () => {
      if (await copyAddress(true)) {
        toast.error(t("chat.open_support_email_copied", { email: emailAddress }));
        return;
      }
      toast.error(t("chat.open_support_email_failed"));
    });
  };

  const linkClass = compact
    ? "inline-flex w-fit items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-3xs text-foreground transition-colors hover:border-primary/30 hover:bg-accent"
    : "inline-flex w-fit items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground shadow-sm transition-colors hover:border-primary/30 hover:bg-accent";
  const iconClass = compact ? "size-3 shrink-0 text-primary/70" : "size-3.5 shrink-0 text-primary/70";
  const copyBtnClass = compact
    ? "inline-flex items-center justify-center rounded-md border border-border bg-background p-1 text-muted-foreground transition-colors hover:border-primary/30 hover:bg-accent hover:text-foreground"
    : "inline-flex items-center justify-center rounded-lg border border-border bg-card p-1.5 text-muted-foreground shadow-sm transition-colors hover:border-primary/30 hover:bg-accent hover:text-foreground";

  return (
    <div className={`${compact ? "mt-2" : "mt-2.5"} inline-flex w-fit items-center gap-1.5 ${revealClass}`}>
      <a
        href={url}
        target={isMailto ? undefined : "_blank"}
        rel={isMailto ? undefined : "noreferrer"}
        onClick={isMailto ? handleMailClick : undefined}
        className={linkClass}
      >
        {isMailto ? <Mail className={iconClass} /> : <Headphones className={iconClass} />}
        {label}
      </a>
      {isMailto && emailAddress && (
        <button
          type="button"
          onClick={() => void copyAddress()}
          className={copyBtnClass}
          title={copied ? t("chat.copied") : t("chat.copy")}
          aria-label={copied ? t("chat.copied") : t("chat.copy")}
        >
          {copied ? (
            <Check className={`${compact ? "size-3" : "size-3.5"} text-success`} />
          ) : (
            <Copy className={compact ? "size-3" : "size-3.5"} />
          )}
        </button>
      )}
    </div>
  );
}
