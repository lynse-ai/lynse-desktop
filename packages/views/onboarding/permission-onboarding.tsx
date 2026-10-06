import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CalendarDays, ListTodo, Mic, RotateCcw, Sparkles, Volume2 } from "lucide-react";

import { useTranslation } from "@lynse/core/i18n/react";
import { Alert, AlertDescription, AlertTitle } from "@lynse/ui/components/ui/alert";
import { Button } from "@lynse/ui/components/ui/button";
import { Switch } from "@lynse/ui/components/ui/switch";
import { cn } from "@lynse/ui/lib/utils";
import { LYNSE_LOGO_SRC } from "../auth/lynse-logo";
import { getDesktopAppApi, getAppInfoSync } from "../app-update";
import { getDesktopLiveTranslationApi } from "../live-translation/desktop-api";
import type { LivePermissionStatus } from "../live-translation/types";

/**
 * localStorage flag marking the permission onboarding as answered. Desktop
 * only — the gate is a no-op wherever the desktop bridge is absent (web),
 * so the flag is never read or written there.
 */
export const PERMISSION_ONBOARDING_DONE_KEY = "lynse_permission_onboarding_done";

type PermissionKind = "microphone" | "systemAudio" | "calendar";

/**
 * First-launch gate: until the user has answered the permission page (or
 * skipped it), the onboarding face renders instead of the dashboard. Sits
 * inside AuthGate, so it only ever shows for signed-in desktop users.
 */
export function PermissionOnboardingGate({ children }: { children: ReactNode }) {
  const [needed, setNeeded] = useState(false);

  useEffect(() => {
    const api = getDesktopLiveTranslationApi();
    if (!api) return;
    let done = false;
    try {
      done = localStorage.getItem(PERMISSION_ONBOARDING_DONE_KEY) === "1";
    } catch {
      done = false;
    }
    if (!done) setNeeded(true);
  }, []);

  const finish = useCallback(() => {
    try {
      localStorage.setItem(PERMISSION_ONBOARDING_DONE_KEY, "1");
    } catch {
      // Storage unavailable — the gate would re-show next launch, which is
      // the safe direction; never block the user over it.
    }
    setNeeded(false);
  }, []);

  if (!needed) return children;
  return <PermissionOnboarding onFinish={finish} />;
}

/**
 * The Pocket-style permission page: a left setup column (logo, title, the
 * required permission rows (microphone, system audio) plus the optional
 * macOS-only calendar row — toggles fire the real TCC prompts — a Continue
 * that unlocks once the required rows are granted (the optional row never
 * gates it), and a "later" escape hatch so a denied permission can never
 * lock the user out) and a right product collage showing what the
 * permissions unlock. The collage hides below the 900px split — the
 * packaged main window is a fixed 960×600, so the split must land under it
 * (not Tailwind's `lg`) or it would never show. Theme-token based
 * throughout, so it follows the user's light/dark appearance (unlike the
 * forced-dark login face).
 */
export function PermissionOnboarding({ onFinish }: { onFinish: () => void }) {
  const { t } = useTranslation();
  const [perms, setPerms] = useState<LivePermissionStatus | null>(null);
  const [requesting, setRequesting] = useState<PermissionKind | null>(null);

  const micGranted = perms?.microphone === "granted";
  // Windows loopback needs no OS consent (always "granted"); keep the row
  // honest on any future platform that flips systemAudioRequired.
  const audioGranted = perms
    ? perms.systemAudio === "granted" || !perms.systemAudioRequired
    : false;
  const allGranted = micGranted && audioGranted;
  // Optional calendar row: macOS EventKit only. Windows reports
  // "unsupported" (no readable local calendar API for unpackaged apps —
  // cloud calendars come via Connections) and older binaries omit the field;
  // either way the row stays hidden and never gates Continue.
  const calendarVisible = !!perms?.calendar && perms.calendar !== "unsupported";
  const calendarGranted = perms?.calendar === "granted";
  const calendarPending = calendarVisible && !calendarGranted;
  // macOS quirk: a fresh Screen & System Audio Recording grant only takes
  // effect after a full app restart (the sidecar owns the ScreenCaptureKit
  // session), so completion means relaunching until then.
  const needsRestart = perms?.restartRequired === true;

  useEffect(() => {
    const api = getDesktopLiveTranslationApi();
    if (!api) return;
    let cancelled = false;
    api.permissions()
      .then((next) => {
        if (!cancelled) setPerms(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll while any visible row is incomplete so a grant flipped inside
  // System Settings (macOS opens the privacy pane for system audio) lights
  // the toggle up without any user action back in the app. The optional
  // calendar row is included — a denial flipped in the pane should still
  // light up even once the required rows are green. The status command is
  // cheap and the loop stops the moment everything visible is granted.
  useEffect(() => {
    if (allGranted && !calendarPending) return;
    const api = getDesktopLiveTranslationApi();
    if (!api) return;
    const timer = window.setInterval(() => {
      api.permissions()
        .then((next) => setPerms(next))
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [allGranted, calendarPending]);

  const request = useCallback(async (kind: PermissionKind) => {
    const api = getDesktopLiveTranslationApi();
    if (!api || requesting) return;
    setRequesting(kind);
    try {
      const next = await api.requestPermission(kind);
      setPerms(next);
      // The native prompt can still end ungranted (dismissed, or previously
      // denied). Every path jumps the user to the pane where the grant lives,
      // and the poll loop lights the toggle up once they flip it there — but
      // each jump lives in exactly one place: the Rust request itself opens
      // the screen-recording pane (macOS systemAudio) and the Windows mic
      // privacy page, so from here only the macOS microphone and calendar
      // rows need the nudge.
      const ungranted =
        kind === "microphone"
          ? next.microphone !== "granted"
          : kind === "calendar"
            ? next.calendar !== "granted"
            : false;
      if (ungranted && getAppInfoSync()?.platform === "darwin") {
        await api.openPrivacyPane(kind);
      }
    } catch {
      // Keep the last snapshot; the poll loop re-reads the status anyway.
    } finally {
      setRequesting(null);
    }
  }, [requesting]);

  const handlePrimary = useCallback(() => {
    // Persist completion before anything else: after a relaunch the gate
    // must not come back up.
    onFinish();
    if (needsRestart) void getDesktopAppApi()?.relaunchApp();
  }, [needsRestart, onFinish]);

  return (
    /* Locked to the viewport, theme-driven tokens throughout: this face
       shows post-login where the user's own appearance applies (no forced
       dark like the login artwork). */
    <main className="relative flex h-dvh overflow-hidden bg-background text-foreground">
      {/* The onboarding face replaces the whole dashboard, so it carries its
          own drag strip — the unified title bar is not mounted here. */}
      <div aria-hidden data-tauri-drag-region className="absolute inset-x-0 top-0 z-20 h-11" />

      {/* ── Left column — the setup face ── */}
      <div className="relative z-10 flex w-full flex-col items-center justify-center overflow-y-auto px-6 py-10 min-[900px]:w-1/2 min-[900px]:shrink-0 lg:px-12">
        {/* Single soft brand glow behind the column — the only ornament,
            kept token-based so it reads correctly in both appearances. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-32 left-1/2 size-[420px] -translate-x-1/2 rounded-full bg-primary/5 blur-3xl"
        />

        <div className="relative flex w-full max-w-md animate-page-in flex-col items-center">
          <img src={LYNSE_LOGO_SRC} alt="Lynse" className="h-5 w-auto dark:invert" />
          <h1 className="mt-7 text-balance text-center text-2xl font-semibold tracking-tight">
            {t("onboarding.title")}
          </h1>
          <p className="mt-3 text-balance text-center text-sm leading-relaxed text-muted-foreground">
            {t("onboarding.subtitle")}
          </p>

          <div className="mt-9 w-full overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            <PermissionRow
              icon={<Mic className="size-4" />}
              title={t("onboarding.mic_title")}
              description={t("onboarding.mic_desc")}
              hint={perms?.microphone === "denied" ? t("onboarding.mic_denied_hint") : null}
              granted={micGranted}
              busy={perms === null || requesting === "microphone"}
              onRequest={() => void request("microphone")}
            />
            <div className="mx-5 border-t border-dashed border-border" />
            <PermissionRow
              icon={<Volume2 className="size-4" />}
              title={t("onboarding.system_audio_title")}
              description={t("onboarding.system_audio_desc")}
              hint={perms?.systemAudio === "denied" ? t("onboarding.system_audio_denied_hint") : null}
              granted={audioGranted}
              busy={perms === null || requesting === "systemAudio"}
              onRequest={() => void request("systemAudio")}
            />
            {/* Optional macOS-only row — never counted into `allGranted`, so
                the app stays fully usable without it. */}
            {calendarVisible && (
              <>
                <div className="mx-5 border-t border-dashed border-border" />
                <PermissionRow
                  icon={<CalendarDays className="size-4" />}
                  title={t("onboarding.calendar_title")}
                  description={t("onboarding.calendar_desc")}
                  hint={
                    perms?.calendar === "denied" ? t("onboarding.calendar_denied_hint") : null
                  }
                  granted={calendarGranted}
                  busy={perms === null || requesting === "calendar"}
                  required={false}
                  onRequest={() => void request("calendar")}
                />
              </>
            )}
          </div>

          {needsRestart && (
            <Alert className="mt-4 w-full">
              <RotateCcw className="size-4" />
              <AlertTitle className="text-sm">{t("live_translation.restart_title")}</AlertTitle>
              <AlertDescription className="text-xs">
                {t("live_translation.restart_hint")}
              </AlertDescription>
            </Alert>
          )}

          <Button
            className="mt-9 h-11 w-full rounded-full text-sm"
            disabled={!allGranted}
            onClick={handlePrimary}
          >
            {needsRestart ? t("onboarding.restart_now") : t("onboarding.continue")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 h-8 text-xs text-muted-foreground"
            onClick={onFinish}
          >
            {t("onboarding.skip")}
          </Button>
        </div>
      </div>

      {/* ── Right column — what the permissions unlock: a static collage of
          the recording surface with floating outcome chips, all localized.
          Decorative only (aria-hidden); collapses below the 900px split —
          the packaged main window is a fixed 960×600, so the split must
          land under it or it would never show. ── */}
      <aside
        aria-hidden
        className="relative hidden flex-1 items-center justify-center overflow-hidden border-l border-border/60 bg-gradient-to-b from-primary/10 via-transparent to-primary/5 min-[900px]:flex"
      >
        <div className="relative w-[82%] max-w-[520px] rounded-2xl border border-border/70 bg-card shadow-xl">
          <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{t("onboarding.promo_meeting")}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {t("onboarding.promo_source")}
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive">
              <span className="size-1.5 animate-pulse rounded-full bg-destructive" />
              {t("onboarding.promo_stop")}
            </span>
          </div>
          <div className="space-y-4 px-4 py-4">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t("onboarding.promo_transcript_title")}
            </p>
            <PromoLine
              name={t("onboarding.promo_sp1_name")}
              text={t("onboarding.promo_sp1_text")}
              tone="bg-primary/15 text-primary"
            />
            <PromoLine
              name={t("onboarding.promo_sp2_name")}
              text={t("onboarding.promo_sp2_text")}
              tone="bg-muted text-muted-foreground"
            />
            <PromoLine
              name={t("onboarding.promo_sp3_name")}
              text={t("onboarding.promo_sp3_text")}
              tone="bg-primary/15 text-primary"
            />
          </div>
        </div>

        <div className="absolute left-[6%] top-[20%] flex items-center gap-2 rounded-xl border border-border/70 bg-card/90 px-3 py-2 shadow-lg backdrop-blur">
          <Sparkles className="size-3.5 shrink-0 text-primary" />
          <span className="text-xs">{t("onboarding.promo_chip_ai")}</span>
        </div>
        <div className="absolute bottom-[16%] right-[7%] flex items-center gap-2 rounded-xl border border-border/70 bg-card/90 px-3 py-2 shadow-lg backdrop-blur">
          <ListTodo className="size-3.5 shrink-0 text-primary" />
          <span className="text-xs">{t("onboarding.promo_chip_todo")}</span>
        </div>
      </aside>
    </main>
  );
}

function PermissionRow({
  icon,
  title,
  description,
  hint,
  granted,
  busy,
  required = true,
  onRequest,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  hint: string | null;
  granted: boolean;
  busy: boolean;
  /** Marks the row as mandatory (red asterisk). Optional rows — calendar —
   * render without it and never gate the Continue button. */
  required?: boolean;
  onRequest: () => void;
}) {
  return (
    <div className="flex items-start gap-3 px-5 py-4">
      <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {title} {required && <span className="text-destructive">*</span>}
        </p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        {hint && <p className="mt-1.5 text-xs leading-relaxed text-destructive">{hint}</p>}
      </div>
      {/* The toggle is the Pocket-reference affordance: flipping it on fires
          the native permission prompt and — when the request ends ungranted —
          jumps straight to the matching System Settings pane (see `request`);
          the poll picks up a grant flipped there either way. */}
      <Switch
        className="mt-1"
        checked={granted}
        disabled={busy}
        onCheckedChange={() => onRequest()}
      />
    </div>
  );
}

function PromoLine({ name, text, tone }: { name: string; text: string; tone: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={cn(
          "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-3xs font-semibold",
          tone,
        )}
      >
        {name.slice(0, 1)}
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium">{name}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}
