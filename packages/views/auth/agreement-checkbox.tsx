"use client";

import { useTranslation } from "@lynse/core/i18n/react";
import { Check } from "../icons";
import { privacyUrl, termsUrl } from "../about/links";

/** The user-agreement round check + inline terms/privacy links, shared by
 *  the phone sign-in form and the WeChat bind form. */
export function AgreementCheckbox({
  agreed,
  onToggle,
  onLink,
}: {
  agreed: boolean;
  onToggle: () => void;
  onLink: (url: string) => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className="mt-4 flex items-start gap-2">
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
      <p className="text-left text-2xs leading-relaxed text-muted-foreground text-pretty">
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

