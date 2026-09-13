"use client";

import { useNavigation } from "../navigation";
import { useTranslation } from "@lynse/core/i18n/react";
import { ApiAuthPanel } from "./api-auth-panel";

/**
 * Standalone API configuration page (login page's corner link, /api-config
 * route). The form itself is the same `ApiAuthPanel` the login page's API
 * view renders — API configuration and API sign-in are one UI. This wrapper
 * only adds the back link and the page intro.
 */
export function ApiConfigPage() {
  const { t } = useTranslation();
  const { push } = useNavigation();

  return (
    <main className="flex min-h-screen flex-col items-center bg-background px-4">
      <div className="mt-[12vh] w-full max-w-xs space-y-4">
        <button
          type="button"
          onClick={() => push("/")}
          className="text-2xs text-muted-foreground transition-colors hover:text-foreground"
        >
          ← {t("auth.api_config_back")}
        </button>

        <div className="space-y-1 text-center">
          <h1 className="text-sm font-medium">{t("auth.api_config_title")}</h1>
          <p className="text-2xs leading-relaxed text-muted-foreground">
            {t("auth.api_config_hint")}
          </p>
        </div>

        <ApiAuthPanel onSuccess={() => push("/")} />
      </div>
    </main>
  );
}
