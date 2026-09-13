"use client";

import { Fragment } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import {
  getAppInfoSync,
  getDesktopAppApi,
  openAppUpdateDialog,
  useAppUpdate,
} from "../app-update";
import { openLogsFolder, openReportProblemDialog } from "../diagnostics";
import { LYNSE_APP_ICON_SRC } from "./app-icon";
import { PRIVACY_URL, TERMS_URL, WEBSITE_URL } from "./links";

/** Open a URL in the system browser, falling back to a new tab on web. */
function openInBrowser(url: string): void {
  const desktopWindow = window as Window & {
    desktopAPI?: { openExternal?: (url: string) => Promise<void> };
  };
  if (desktopWindow.desktopAPI?.openExternal) {
    void desktopWindow.desktopAPI.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

/**
 * The About panel body: app icon, name, version, update entry, legal links
 * and copyright — mirroring the classic native About window layout. Rendered
 * inside the standalone desktop window (`AboutWindow`) and the web fallback
 * dialog (`AboutDialog`); the parent supplies the height.
 */
export function AboutContent() {
  const { t } = useTranslation();
  // Subscribing also keeps the update entry in sync with the shared 30-min
  // background check, so "update available" shows without a manual check.
  const { update, checking } = useAppUpdate();
  const isDesktop = Boolean(getDesktopAppApi());
  const appInfo = getAppInfoSync();
  // Build number in parentheses after the version, native-About style
  // ("1.0.3 (107)") — present only in bundled macOS releases.
  const versionLabel = appInfo
    ? `v${appInfo.version}${appInfo.build ? ` (${appInfo.build})` : ""}`
    : "—";
  const hasUpdate = Boolean(update?.hasUpdate);
  const year = new Date().getFullYear();

  const links = [
    { label: t("about.website"), url: WEBSITE_URL },
    { label: t("about.terms"), url: TERMS_URL },
    { label: t("about.privacy"), url: PRIVACY_URL },
  ];

  return (
    <div className="flex h-full min-h-0 w-full flex-col items-center overflow-y-auto px-6 pb-6 pt-9 text-center">
      <img
        src={LYNSE_APP_ICON_SRC}
        alt=""
        draggable={false}
        className="size-20 shrink-0 select-none"
      />
      <h1 className="mt-4 text-base font-semibold tracking-tight">
        {t("app_name")}
      </h1>
      <p className="mt-1 text-xs tabular-nums text-muted-foreground">
        {versionLabel}
      </p>

      {/* Update entry — the shared update dialog (mounted by the host of this
          content) owns the whole check / download / install flow. */}
      <Button
        size="sm"
        variant={hasUpdate ? "default" : "outline"}
        className="mt-5 h-7 text-xs"
        onClick={() => openAppUpdateDialog({ refresh: true })}
        disabled={checking}
      >
        {hasUpdate
          ? t("settings.update_available")
          : checking
            ? t("settings.checking_update")
            : t("settings.check_update")}
      </Button>

      {/* Legal links, separated by hairlines like a native About panel. */}
      <div className="mt-6 flex items-center text-xs text-muted-foreground">
        {links.map((link, index) => (
          <Fragment key={link.url}>
            {index > 0 && <span aria-hidden className="mx-3 h-3 w-px bg-border" />}
            <button
              type="button"
              onClick={() => openInBrowser(link.url)}
              className="transition-colors hover:text-foreground"
            >
              {link.label}
            </button>
          </Fragment>
        ))}
      </div>

      {/* Diagnostics shortcuts carried over from the old settings About card.
          The log folder needs the desktop host, so it hides on web. */}
      <div className="mt-2.5 flex items-center gap-4 text-2xs text-muted-foreground/80">
        <button
          type="button"
          onClick={openReportProblemDialog}
          className="transition-colors hover:text-foreground"
        >
          {t("settings.report_issue")}
        </button>
        {isDesktop && (
          <button
            type="button"
            onClick={openLogsFolder}
            className="transition-colors hover:text-foreground"
          >
            {t("settings.open_logs_folder")}
          </button>
        )}
      </div>

      {/* Copyright block pinned to the bottom like a native About panel. */}
      <div className="mt-auto flex flex-col items-center gap-1.5 pt-6">
        <p className="text-xs text-muted-foreground">
          {t("about.copyright_owner")}
        </p>
        <p className="text-2xs tabular-nums text-muted-foreground/80">
          {t("about.copyright_notice", { year })}
        </p>
      </div>
    </div>
  );
}
