"use client";

import { getDesktopLiveTranslationApi } from "./desktop-api";
import { toast } from "sonner";

import { useRef, useEffect, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { Checkbox } from "@lynse/ui/components/ui/checkbox";
import type { CompletedLiveSession } from "./types";
import { Play, Pause } from "../icons";
import { IconSwap } from "../icon-swap";
import { useWaveformPeaks } from "../workspace/use-waveform-peaks";
import { WaveformProgress } from "../workspace/waveform-progress";

// ───────────────────────────────────────────────────────────────
// Recording Complete Dialog
//
// Modal shown after a recording session stops. The audio sits in a
// local cache persisted by the Rust sidecar; "保存" keeps it (and
// uploads to the cloud when "保存到云" is ticked), "取消" cancels the
// save and deletes the cached recording. The preview player lets the
// user listen before choosing.
// ───────────────────────────────────────────────────────────────

interface RecordingCompleteDialogProps {
  /** The completed session delivered by the `completed` event once the
   *  background finalization of a stopped recording finishes. */
  readonly completedSession: CompletedLiveSession | null;
  /** Whether the dialog is currently open. */
  readonly open: boolean;
  /** Called when the dialog should close (user dismisses or acts). */
  readonly onOpenChange: (open: boolean) => void;
  /** Called when the user confirms "保存到云" (checkbox checked + 保存). */
  readonly onSavedLocal?: (session: CompletedLiveSession) => void;
  readonly onSave?: (session: CompletedLiveSession) => void;
  /** Called when the user taps "取消" — cancel the save and delete the
   *  cached recording. */
  readonly onDiscard?: (session: CompletedLiveSession) => void;
  /** Called when the "remember choice" checkbox value changes. */
  readonly onRememberChoiceChange?: (remember: boolean) => void;
}

/** Format ms into a human-readable short string like "27秒" or "1分30秒". */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}秒`;
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return ss > 0 ? `${mm}分${ss}秒` : `${mm}分`;
}

// ── "Remember my choice" persistence ─────────────────────────────
// The "保存到云" checkbox is opt-in per recording. When the user ticks
// "记住选择", we remember both the flag and the chosen value in
// localStorage so the next recording opens with the same selection.
const REMEMBER_PREF_KEY = "lynse_rec_save_to_cloud_pref";

interface RememberPref {
  remember: boolean;
  saveToCloud: boolean;
}

function loadRememberPref(): RememberPref {
  if (typeof window === "undefined") return { remember: false, saveToCloud: false };
  try {
    const raw = window.localStorage.getItem(REMEMBER_PREF_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RememberPref>;
      return {
        remember: parsed.remember === true,
        saveToCloud: parsed.saveToCloud === true,
      };
    }
  } catch {
    /* ignore corrupt pref */
  }
  return { remember: false, saveToCloud: false };
}

function saveRememberPref(pref: RememberPref): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(REMEMBER_PREF_KEY, JSON.stringify(pref));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

/** Derive a display filename from a completed session — or from anything
 *  carrying the playback path (e.g. a local transcription record). */
export function deriveFilename(
  session: Pick<CompletedLiveSession, "playbackPath">,
): string {
  if (session.playbackPath) {
    const parts = session.playbackPath.split(/[/\\]/);
    const last = parts[parts.length - 1];
    if (last && /\./.test(last)) return last;
  }
  const d = new Date();
  const ts = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
    "_",
    String(d.getHours()).padStart(2, "0"),
    String(d.getMinutes()).padStart(2, "0"),
  ].join("");
  return `${ts}_Recording.wav`;
}

export function RecordingCompleteDialog({
  completedSession,
  open,
  onOpenChange,
  onSavedLocal,
  onSave,
  onDiscard,
  onRememberChoiceChange,
}: RecordingCompleteDialogProps) {
  const { t } = useTranslation();
  const [remember, setRemember] = useState(false);
  const [saveToCloud, setSaveToCloud] = useState(false);

  // Seed the checkboxes from the persisted preference each time the dialog
  // opens. When "记住选择" was previously ticked, pre-check "保存到云" with the
  // remembered value; otherwise start fresh.
  useEffect(() => {
    if (!open || !completedSession) return;
    const pref = loadRememberPref();
    setRemember(pref.remember);
    setSaveToCloud(pref.remember ? pref.saveToCloud : false);
  }, [open, completedSession]);

  if (!completedSession || !open) return null;

  // Narrow for closures — TS doesn't track early-return narrowing into handlers.
  const session = completedSession;
  const filename = deriveFilename(session);

  function handlePrimary() {
    if (remember) saveRememberPref({ remember: true, saveToCloud });
    const desktopApi = getDesktopLiveTranslationApi();
    if (!desktopApi) {
      onSavedLocal?.(session);
      if (saveToCloud) onSave?.(session);
      onOpenChange(false);
      return;
    }
    void desktopApi.finalizeLocal(session.sessionId, false).then(() => {
      onSavedLocal?.(session);
      if (saveToCloud) onSave?.(session);
      onOpenChange(false);
    }).catch((error: unknown) => toast.error(String(error)));
    return;
  }

  // 取消 = cancel the save: hand the session to onDiscard, which deletes
  // the cached recording; 保存 keeps it (plus cloud sync when ticked).
  function handleCancel() {
    onDiscard?.(session);
    onOpenChange(false);
  }

  function handleRememberChange(checked: boolean | "indeterminate") {
    const val = checked === true;
    setRemember(val);
    onRememberChoiceChange?.(val);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md gap-0 overflow-hidden p-0"
      >
        {/* ═══ Body ═══ */}
        <div className="flex flex-col gap-4 px-6 pt-6 pb-2">
          {/* Title */}
          <DialogTitle className="text-lg font-semibold leading-tight text-balance">
            {t("recording_mode.complete_title")}
          </DialogTitle>

          {/* Info card */}
          <div className="rounded-xl bg-muted/60 px-4 py-3">
            <div className="flex items-center justify-between gap-4 text-13">
              <span className="text-muted-foreground">{t("recording_mode.complete_duration")}</span>
              <span className="font-medium tabular-nums">{formatDuration(session.durationMs)}</span>
            </div>
            <div className="mt-2 flex items-center justify-between gap-4 text-13">
              <span className="text-muted-foreground">{t("recording_mode.complete_filename")}</span>
              <span className="truncate font-mono text-xs text-foreground/80 max-w-[55%]">{filename}</span>
            </div>
          </div>

          {/* Instant preview — hear the recording right away (local playback) */}
          {session.playbackUrl && <RecordingPreview src={session.playbackUrl} />}

          {/* Description */}
          <p className="text-13 leading-relaxed text-muted-foreground">
            {t("recording_mode.complete_description")}
          </p>

          {/* Save-to-cloud checkbox — recording is already local; cloud is opt-in */}
          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
            <Checkbox
              checked={saveToCloud}
              onCheckedChange={(checked) => setSaveToCloud(checked === true)}
            />
            <span className="text-13 font-medium text-foreground select-none">
              {t("recording_mode.complete_save_to_cloud")}
            </span>
          </label>

          {/* Remember choice checkbox */}
          <label className="flex cursor-pointer items-center gap-2.5 self-center pb-1">
            <Checkbox
              checked={remember}
              onCheckedChange={handleRememberChange}
            />
            <span className="text-13 text-muted-foreground select-none">
              {t("recording_mode.complete_remember")}
            </span>
          </label>
        </div>

        {/* ═══ Footer buttons — centered 取消 / 保存 ═══ */}
        <div className="flex items-center justify-center gap-3 border-t border-border/60 bg-background px-6 py-4">
          <Button
            variant="outline"
            onClick={handleCancel}
            className="min-w-[96px]"
          >
            {t("recording_mode.complete_cancel")}
          </Button>
          <Button
            onClick={handlePrimary}
            className="min-w-[96px] bg-foreground text-background hover:bg-foreground/90"
          >
            {saveToCloud
              ? t("recording_mode.complete_save_cloud")
              : t("recording_mode.complete_save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────────────────────────────────────────────
// Compact playback preview for the completed recording.
//
// Plays the local WAV captured by the sidecar (`playbackUrl`) through a
// hidden `<audio>` element and shows a waveform scrubber (ElevenLabs UI
// style) with play/pause + elapsed time. Falls back to a plain time row
// while peaks are being decoded or if the source isn't fetchable.
// ───────────────────────────────────────────────────────────────
function RecordingPreview({ src }: { src: string }) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const { peaks } = useWaveformPeaks(src);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      void audio.play().catch(() => undefined);
    }
  };

  const seekToRatio = (ratio: number) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    audio.currentTime = ratio * duration;
    setCurrentTime(ratio * duration);
  };

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={playing ? t("recording_mode.pause") : t("recording_mode.resume")}
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-[background-color,transform] duration-150 hover:bg-foreground/90 active:scale-[0.96]"
        >
          <IconSwap stateKey={playing ? "pause" : "play"}>
            {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5 ml-0.5" />}
          </IconSwap>
        </button>

        <div className="min-w-0 flex-1">
          {peaks.length > 0 ? (
            <WaveformProgress
              peaks={peaks}
              progress={progress}
              onSeek={seekToRatio}
              height={32}
            />
          ) : (
            <div className="flex h-8 items-center text-2xs text-muted-foreground">
              {t("recording_mode.preview_loading")}
            </div>
          )}
        </div>

        <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
          {formatClock(currentTime)} / {formatClock(duration)}
        </span>
      </div>

      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onTimeUpdate={() => audioRef.current && setCurrentTime(audioRef.current.currentTime)}
        onLoadedMetadata={() => audioRef.current && setDuration(audioRef.current.duration)}
        onPlaying={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
    </div>
  );
}

function formatClock(seconds: number): string {
  if (!isFinite(seconds) || isNaN(seconds)) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
