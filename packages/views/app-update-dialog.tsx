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
import { ArrowUp, Download, Loader2, RefreshCw } from "./icons";
import {
  getAppInfoSync,
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
      <DialogContent className="sm:max-w-md" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {hasUpdate ? (
              <>
                <ArrowUp className="size-4 text-warning" strokeWidth={2.5} />
                {t("settings.update_available")}
              </>
            ) : (
              t("settings.up_to_date")
            )}
          </DialogTitle>
          <DialogDescription>
            {hasUpdate ? (
              <span className="inline-flex items-center gap-1.5 tabular-nums">
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs">v{update?.currentVersion}</span>
                <span aria-hidden>→</span>
                <span className="rounded bg-warning/15 px-1.5 py-0.5 text-xs font-semibold text-warning-text">
                  v{update?.latestVersion}
                </span>
              </span>
            ) : (
              `${t("settings.version")}: v${currentVersion}`
            )}
          </DialogDescription>
        </DialogHeader>

        {hasUpdate && update?.releaseNotes ? (
          <div className="max-h-44 overflow-y-auto rounded-md border bg-muted/40 p-2.5">
            <p className="mb-1 text-2xs font-medium text-muted-foreground">
              {t("settings.update_release_notes")}
            </p>
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/80">
              {update.releaseNotes}
            </p>
          </div>
        ) : hasUpdate ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("settings.update_available_desc")}
          </p>
        ) : null}

        {checking && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            {t("settings.checking_update")}
          </p>
        )}

        {progressLabel && (
          <div className="space-y-1.5 rounded-md border border-primary/30 bg-primary/5 p-2.5">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
              {progressLabel}
            </p>
            {installState.phase === "downloading" && (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary/15">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${percent}%` }}
                />
              </div>
            )}
          </div>
        )}

        {failed && (
          <p className="text-xs text-destructive">
            {t("settings.update_install_failed", { error: installState.error ?? "" })}
          </p>
        )}
        {!hasUpdate && error && !busy && (
          <p className="text-xs text-destructive">{t("settings.update_check_failed")}</p>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={busy}>
            {hasUpdate ? t("settings.update_later") : t("settings.update_close")}
          </Button>
          {hasUpdate ? (
            <Button size="sm" onClick={install} disabled={busy || checking}>
              {failed ? (
                <RefreshCw className="size-3.5" />
              ) : (
                <Download className="size-3.5" />
              )}
              {failed ? t("settings.update_retry") : t("settings.install_update")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openExternalUrl(update?.releaseUrl ?? "")}
              disabled={checking}
            >
              {t("settings.view_release")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
