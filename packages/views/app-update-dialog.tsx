"use client";

import { useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { useTranslation } from "@lynse/core/i18n/react";
import { Download, RefreshCw } from "./icons";
import { ActivityIndicator } from "@lynse/ui/components/ui/activity-indicator";
import { ReleaseNotesContent } from "./release-notes-content";
import { DOWNLOAD_URL } from "./about/links";
import {
  getAppInfoSync,
  isSandboxedMacApp,
  openExternalUrl,
  useAppUpdate,
  useAppUpdateDialog,
} from "./app-update";

/**
 * Standalone "update available" dialog: shows what's new, then downloads,
 * verifies, installs and relaunches — all in place, without sending the user
 * to Settings → About and back.
 *
 * Mount once near the app root; visibility is driven by the shared store in
 * `app-update.ts` (`openAppUpdateDialog()` works from anywhere).
 */
export function AppUpdateDialog() {
  const { t } = useTranslation();
  const { open, setOpen } = useAppUpdateDialog();
  const { update, checking, error, checkForUpdate, install, installState } = useAppUpdate();

  const busy =
    installState.phase === "downloading" ||
    installState.phase === "installing" ||
    installState.phase === "restarting";
  const percent =
    installState.total > 0
      ? Math.min(100, Math.round((installState.downloaded / installState.total) * 100))
      : 0;

  // On a cold open (no check has completed yet) run one so the dialog never
  // renders an empty state. Guarded by a ref so it fires once per opening.
  const checkedOnOpen = useRef(false);
  useEffect(() => {
    if (!open) {
      checkedOnOpen.current = false;
      return;
    }
    if (checkedOnOpen.current) return;
    checkedOnOpen.current = true;
    if (!update && !checking) checkForUpdate();
  }, [open, update, checking, checkForUpdate]);

  const currentVersion = getAppInfoSync()?.version ?? update?.currentVersion ?? "—";
  const hasUpdate = Boolean(update?.hasUpdate);
  const failed = installState.phase === "failed";
  // TestFlight/App Store builds run sandboxed and can never install an
  // update in place (EPERM replacing /Applications/<app>) — send the user to
  // the website download page instead; installing the direct build once
  // migrates them off TestFlight and in-app updates take over from there.
  const sandboxed = isSandboxedMacApp();

  const progressLabel = busy
    ? installState.phase === "downloading"
      ? t("settings.update_downloading", { percent })
      : installState.phase === "installing"
        ? t("settings.update_installing")
        : t("settings.update_restarting")
    : null;

  return (
    <Dialog
      open={open}
      disablePointerDismissal={busy}
      onOpenChange={(next) => {
        // Esc / outside clicks must not dismiss mid-install — the app is about
        // to relaunch and a closed dialog would hide the progress.
        if (!next && busy) return;
        setOpen(next);
      }}
    >
      <DialogContent
        className={`flex max-h-[88dvh] w-[calc(100%-4rem)] flex-col gap-0 overflow-hidden p-0 ${hasUpdate ? "sm:max-w-4xl lg:max-w-5xl" : "sm:max-w-md"}`}
        showCloseButton={!busy}
      >
        <DialogHeader className="shrink-0 gap-1.5 border-b border-border/70 px-8 py-6 pr-12">
          <DialogTitle className="text-lg leading-6 font-semibold">
            {hasUpdate
              ? t("settings.update_to_version", { version: update?.latestVersion })
              : checking
                ? t("settings.checking_update")
                : error
                  ? t("settings.update_check_failed")
                  : update
                    ? t("settings.up_to_date")
                    : t("settings.check_update")}
          </DialogTitle>
          <DialogDescription>
            <span className="tabular-nums">
              {currentVersion === "—" ? `${t("settings.version")}: —` : t("settings.update_current_version", { version: currentVersion })}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-8 py-6 [scrollbar-gutter:stable]" data-slot="update-notes-body">
          {hasUpdate && update?.releaseNotes?.trim() ? (
            <>
              <p className="mb-6 text-[13px] text-muted-foreground">
                {t("settings.update_notes_this_version")}
              </p>
              <ReleaseNotesContent notes={update.releaseNotes} />
            </>
          ) : hasUpdate ? (
            <p className="text-sm leading-6 text-muted-foreground">
              {t("settings.update_notes_missing")}
            </p>
          ) : null}

          {hasUpdate && sandboxed && (
            <p className="mt-4 text-xs leading-5 text-muted-foreground">
              {t("settings.update_website_migration_desc")}
            </p>
          )}

          {checking && (
            <p role="status" className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
              <ActivityIndicator />
              {t("settings.checking_update")}
            </p>
          )}

          {progressLabel && (
            <div className="mt-5 space-y-2 rounded-lg bg-muted/50 px-3 py-3">
              <p role="status" className="flex items-center gap-2 text-sm font-medium">
                <ActivityIndicator className="text-primary" />
                {progressLabel}
              </p>
              {installState.phase === "downloading" && (
                <div
                  role="progressbar"
                  aria-label={progressLabel}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={installState.total > 0 ? percent : undefined}
                  className="h-1.5 w-full overflow-hidden rounded-full bg-primary/15"
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-150 motion-reduce:transition-none"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {failed && (
            <p role="alert" className="mt-4 text-sm leading-6 text-destructive">
              {t("settings.update_install_failed", { error: installState.error ?? "" })}
            </p>
          )}
          {!hasUpdate && error && !busy && (
            <p role="alert" className="mt-4 text-sm text-destructive">{t("settings.update_check_failed")}</p>
          )}
        </div>

        <DialogFooter className="mx-0 mb-0 shrink-0 flex-row flex-wrap justify-end gap-3 rounded-none border-border/70 bg-transparent px-8 py-4">
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            {hasUpdate ? t("settings.update_later") : t("settings.update_close")}
          </Button>
          {hasUpdate ? (
            sandboxed ? (
              <Button className="h-auto min-h-8 whitespace-normal" onClick={() => openExternalUrl(DOWNLOAD_URL)}>
                <Download className="size-3.5" />
                {t("settings.update_download_website")}
              </Button>
            ) : (
              <Button className="h-auto min-h-8 whitespace-normal" onClick={install} disabled={busy || checking}>
                {busy ? (
                  <ActivityIndicator />
                ) : failed ? (
                  <RefreshCw className="size-3.5" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {busy ? progressLabel : failed ? t("settings.update_retry") : t("settings.install_update")}
              </Button>
            )
          ) : error || !update ? (
            <Button onClick={checkForUpdate} disabled={checking}>
              <RefreshCw className="size-3.5" />
              {t("settings.check_update")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openExternalUrl(update?.releaseUrl ?? "")}
              disabled={checking || !update?.releaseUrl}
            >
              {t("settings.view_release")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
