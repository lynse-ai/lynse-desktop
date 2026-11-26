"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { Check } from "../icons";
import { privacyUrl, termsUrl } from "../about/links";
import { isWebPlatform } from "../platform";

/** The user-agreement round check + inline terms/privacy links, shared by
 *  the phone sign-in form and the WeChat bind form. */
export function AgreementCheckbox({
  agreed,
  onToggle,
  onLink,
  className,
}: {
  agreed: boolean;
  onToggle: () => void;
  onLink: (url: string) => void;
  className?: string;
}) {
  const { t, i18n } = useTranslation();
  // Desktop keeps the original left-aligned row; web centers the whole block.
  const web = isWebPlatform();
  return (
    <div className={cn("flex items-start gap-1", web && "justify-center gap-1.5", className)}>
      <button
        type="button"
        role="checkbox"
        aria-checked={agreed}
        onClick={onToggle}
        className={`mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors ${
          agreed ? "border-primary bg-primary" : "border-muted-foreground/60"
        }`}
      >
        {agreed && (
          <Check className="size-2.5 text-primary-foreground" strokeWidth={3.5} />
        )}
      </button>
      <p className={cn(
        "text-2xs leading-relaxed text-muted-foreground",
        web ? "text-center" : "text-left",
      )}>
        {t("auth.agree_prefix")}
        <button
          type="button"
          onClick={() => onLink(termsUrl(i18n.language))}
          className="underline decoration-from-font underline-offset-2 transition-colors hover:text-foreground"
        >
          {t("auth.agree_terms")}
        </button>
        {t("auth.agree_join")}
        <button
          type="button"
          onClick={() => onLink(privacyUrl(i18n.language))}
          className="underline decoration-from-font underline-offset-2 transition-colors hover:text-foreground"
        >
          {t("auth.agree_privacy")}
        </button>
        {t("auth.agree_autocreate")}
      </p>
    </div>
  );
}

