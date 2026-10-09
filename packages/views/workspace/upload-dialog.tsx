"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@lynse/ui/components/ui/dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { Switch } from "@lynse/ui/components/ui/switch";
import { useTranslation } from "@lynse/core/i18n/react";
import { Upload, Loader2, Check, FileAudio, Sparkles } from "../icons";
import { IconSwap } from "../icon-swap";
import { cn } from "@lynse/ui/lib/utils";
import {
  useTransferFile,
  waitForTranscriptionCompletion,
  uploadFileToOSS,
} from "./hooks/use-files";
import { useQueryClient } from "@tanstack/react-query";
import type { UploadPhase } from "./types";
import type { LocalHotwordPackage } from "./types";
import {
  getDesktopLocalTranscriptionApi,
  OFFLINE_TRANSCRIPTION_ENABLED_KEY,
  resolveSttProvider,
  findModelStatus,
} from "./local-transcription";
import { isInsufficientCreditsError, useMembership, useUserCredits } from "../layout/use-user-credits";
import { canUploadToCloud } from "../layout/membership-entitlement";
import { useAuthStore } from "@lynse/core/auth";

// Accepted audio/video file types
const ACCEPTED_TYPES = [
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav",
  "audio/m4a", "audio/mp4", "audio/x-m4a",
  "audio/ogg", "audio/flac", "audio/aac",
  "video/mp4", "video/quicktime", "video/webm",
].join(",");

interface UploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UploadDialog({ open, onOpenChange }: UploadDialogProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();

  // State
  const [file, setFile] = useState<File | null>(null);
  const [localAudioPath, setLocalAudioPath] = useState<string | null>(null);
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [uploadPct, setUploadPct] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [dragOver, setDragOver] = useState(false);
  // Desktop defaults to on-device transcription: keeping the audio local is the
  // safe assumption, and uploading to the cloud is the explicit choice. The web
  // build has no local engine, so it stays on cloud.
  const [mode, setMode] = useState<"cloud" | "local">(() =>
    prefersLocalByDefault() ? "local" : "cloud",
  );
  const [expectedSpeakers, setExpectedSpeakers] = useState("");
  const [selectedHotwordPackageId, setSelectedHotwordPackageId] = useState("");
  const [hotwordPackages, setHotwordPackages] = useState<LocalHotwordPackage[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const transferFile = useTransferFile();

  const localApi = getDesktopLocalTranscriptionApi();
  const useOfflineTranscription = mode === "local" && !!localApi;
  const localAudioName = localAudioPath ? localAudioPath.split(/[\\/]/).pop() ?? localAudioPath : "";
  const selectedFileName = useOfflineTranscription ? localAudioName : file?.name ?? "";
  const hasSelectedSource = useOfflineTranscription ? !!localAudioPath : !!file;

  // Cloud uploads are a paid entitlement: the audio leaves the device and the
  // server spends transcription minutes on it. Local transcription is free and
  // stays open to everyone.
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const membership = useMembership();
  const credits = useUserCredits();
  const canCloud = canUploadToCloud(membership.data, credits.data);
  // Both queries run `enabled: isAuthenticated`, and a disabled query reports
  // pending forever — so "checking…" is only honest while signed in.
  const entitlementPending = isAuthenticated && (membership.isPending || credits.isPending);
  const cloudLockReason = entitlementPending
    ? t("upload.membership_pending")
    : t("upload.membership_required");

  const isProcessing = phase !== "idle" && phase !== "complete" && phase !== "error";

  useEffect(() => {
    if (!open) return;
    // The settings toggle seeds the default; the in-dialog selector can
    // override it per import and persists back to the same key.
    setMode(prefersLocalByDefault() ? "local" : "cloud");
    getDesktopLocalTranscriptionApi()?.listHotwordPackages()
      .then(setHotwordPackages)
      .catch(() => setHotwordPackages([]));
  }, [open]);

  // Once the account is known to lack the entitlement, do not leave the dialog
  // sitting on the option it cannot use — desktop falls back to local.
  useEffect(() => {
    if (!open || canCloud || entitlementPending) return;
    if (localApi) setMode("local");
  }, [open, canCloud, entitlementPending, localApi]);

  const reset = useCallback(() => {
    setFile(null);
    setLocalAudioPath(null);
    setPhase("idle");
    setUploadPct(0);
    setErrorMsg("");
    setDragOver(false);
    setExpectedSpeakers("");
    setSelectedHotwordPackageId("");
  }, []);

  const handleClose = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && isProcessing) return; // Don't close during processing
      if (!nextOpen) reset();
      onOpenChange(nextOpen);
    },
    [isProcessing, reset, onOpenChange],
  );

  // Per-import engine choice. Persisted to the same key the settings toggle
  // uses, so the default next time matches the last choice made here.
  const handleModeChange = useCallback(
    (next: "cloud" | "local") => {
      setMode(next);
      // Each mode keeps its own selection: a browser `File` cannot become a
      // native path and back, so clearing on every switch only punished the
      // user for changing their mind. The start handler uses whichever slot the
      // active mode has filled.
      if (localApi) {
        localStorage.setItem(OFFLINE_TRANSCRIPTION_ENABLED_KEY, next === "local" ? "1" : "0");
      }
    },
    [localApi],
  );

  // File selection handlers
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setFile(f);
  }, []);

  const handleFileInputClick = useCallback(async () => {
    if (useOfflineTranscription) {
      const selectedPath = await localApi?.pickAudioFile();
      if (selectedPath) setLocalAudioPath(selectedPath);
      return;
    }
    fileInputRef.current?.click();
  }, [localApi, useOfflineTranscription]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (useOfflineTranscription) return;
    const f = e.dataTransfer.files?.[0];
    if (f) setFile(f);
  }, [useOfflineTranscription]);

  // Main upload pipeline
  const handleStart = useCallback(async () => {
    if (!hasSelectedSource) return;
    if (!useOfflineTranscription && !file) return;
    // Belt and braces: the cloud card is already disabled, but a keyboard or a
    // stale render must still not start a paid upload on an unentitled account.
    if (!useOfflineTranscription && !canCloud) {
      setErrorMsg(cloudLockReason);
      toast.error(cloudLockReason);
      return;
    }
    setErrorMsg("");

    try {
      if (useOfflineTranscription) {
        if (!localAudioPath || !localApi) return;
        // Pre-flight: the resolved engine's model must be installed.
        const sttConfig = await localApi.getSttConfig().catch(() => ({ default: null, per_language: {} }));
        const { models } = await localApi.listSttModels().catch(() => ({ models: [] }));
        const provider = resolveSttProvider(sttConfig, undefined, undefined);
        const status = findModelStatus(models, provider);
        if (!status || status.status !== "installed") {
          toast.error(t("upload.offline_model_missing"));
          setErrorMsg(t("upload.offline_model_missing"));
          return;
        }
        // Queue and start WITHOUT awaiting the engine: a real meeting takes
        // minutes of CPU (a 43-minute recording is ~19 minutes), and the modal
        // must not hold the user hostage for that. `local-transcription-updated`
        // carries the outcome to the notes list.
        const expectedSpeakersValue = Number.parseInt(expectedSpeakers, 10);
        const record = await localApi.start(localAudioPath, {
          expectedSpeakers: Number.isFinite(expectedSpeakersValue) && expectedSpeakersValue > 0
            ? expectedSpeakersValue
            : undefined,
          // `null` = explicit "none" for this task; `undefined` = fall back to
          // the engine's configured hotword package.
          hotwordPackageId: selectedHotwordPackageId || null,
        });
        qc.invalidateQueries({ queryKey: ["files"] });
        qc.invalidateQueries({ queryKey: ["notes"] });
        toast.success(t("upload.local_queued", { name: record.title || localAudioName }));
        reset();
        onOpenChange(false);
        return;
      }

      if (!file) return;
      // Phase 1: Upload to OSS
      setPhase("uploading");
      setUploadPct(0);
      const fileId = await uploadFileToOSS(file, (pct) => setUploadPct(pct), "IMPORT");

      // Phase 2: Trigger transcription + summarization
      setPhase("transcribing");
      await transferFile.mutateAsync({
        fileId,
      });

      setPhase("summarizing");
      // Initial transcription re-processes the whole audio server-side; match
      // the re-run window so large files aren't cut off at 3 minutes.
      await waitForTranscriptionCompletion({
        fileIds: [fileId],
        intervalMs: 5000,
        maxAttempts: 240, // up to 20 minutes
      });

      // Phase 3: Complete
      setPhase("complete");
      toast.success(t("upload.success"));

      // Refresh file list
      qc.invalidateQueries({ queryKey: ["files"] });
      qc.invalidateQueries({ queryKey: ["file-conclusions", fileId] });
      qc.invalidateQueries({ queryKey: ["file-outline", fileId] });
      qc.invalidateQueries({ queryKey: ["file-transcription", fileId] });

      // Auto-close after 1.5s
      setTimeout(() => {
        reset();
        onOpenChange(false);
      }, 1500);
    } catch (err) {
      setPhase("error");
      const isCreditsError = isInsufficientCreditsError(err);
      const msg = isCreditsError
        ? t("upload.credits_insufficient")
        : err instanceof Error
          ? err.message
          : t("upload.unknown_error");
      setErrorMsg(msg);
      toast.error(
        isCreditsError ? t("upload.credits_insufficient") : t("upload.failed"),
        { description: isCreditsError ? undefined : msg },
      );
    }
  }, [file, transferFile, qc, t, reset, onOpenChange, hasSelectedSource, localApi, localAudioPath, useOfflineTranscription, expectedSpeakers, selectedHotwordPackageId, canCloud, cloudLockReason]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-balance">{t("upload.title")}</DialogTitle>
          <DialogDescription className="text-pretty">{t("upload.description")}</DialogDescription>
        </DialogHeader>

        {phase === "idle" || phase === "error" ? (
          <IdleContent
            file={file}
            localAudioName={localAudioName}
            offlineMode={useOfflineTranscription}
            canTranscribeLocally={!!localApi}
            mode={mode}
            onModeChange={handleModeChange}
            cloudLocked={!canCloud}
            cloudLockReason={cloudLockReason}
            phase={phase}
            errorMsg={errorMsg}
            dragOver={dragOver}
            expectedSpeakers={expectedSpeakers}
            hotwordPackages={hotwordPackages}
            selectedHotwordPackageId={selectedHotwordPackageId}
            onFileSelect={handleFileSelect}
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onExpectedSpeakersChange={setExpectedSpeakers}
            onHotwordPackageSelect={setSelectedHotwordPackageId}
            onFileInputClick={handleFileInputClick}
            fileInputRef={fileInputRef}
          />
        ) : (
          <ProgressContent
            phase={phase}
            uploadPct={uploadPct}
            fileName={selectedFileName}
          />
        )}

        <DialogFooter>
          {phase === "error" && (
            <Button variant="outline" onClick={reset}>
              {t("upload.retry")}
            </Button>
          )}
          {(phase === "idle" || phase === "error") && (
            <>
              <Button variant="outline" onClick={() => handleClose(false)}>
                {t("upload.cancel")}
              </Button>
              <Button
                onClick={handleStart}
                disabled={!hasSelectedSource || (!useOfflineTranscription && !canCloud)}
              >
                <Sparkles className="size-3.5 mr-1.5" />
                {useOfflineTranscription ? t("upload.local_start") : t("upload.start")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Idle state content: mode selector + file picker ──

interface IdleContentProps {
  file: File | null;
  localAudioName: string;
  offlineMode: boolean;
  /** Desktop only — the web build has no local transcription engine. */
  canTranscribeLocally: boolean;
  mode: "cloud" | "local";
  onModeChange: (mode: "cloud" | "local") => void;
  /** Cloud upload is a paid entitlement; the option is shown but not usable. */
  cloudLocked: boolean;
  cloudLockReason: string;
  phase: UploadPhase;
  errorMsg: string;
  dragOver: boolean;
  expectedSpeakers: string;
  hotwordPackages: LocalHotwordPackage[];
  selectedHotwordPackageId: string;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onExpectedSpeakersChange: (value: string) => void;
  onHotwordPackageSelect: (id: string) => void;
  onFileInputClick: () => void | Promise<void>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
}

function IdleContent({
  file,
  localAudioName,
  offlineMode,
  canTranscribeLocally,
  mode,
  onModeChange,
  cloudLocked,
  cloudLockReason,
  phase,
  errorMsg,
  dragOver,
  expectedSpeakers,
  hotwordPackages,
  selectedHotwordPackageId,
  onFileSelect,
  onDrop,
  onDragOver,
  onDragLeave,
  onExpectedSpeakersChange,
  onHotwordPackageSelect,
  onFileInputClick,
  fileInputRef,
}: IdleContentProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      {/* Per-import choice: upload to the cloud (server transcription) or
          keep the audio on this device (on-device transcription). Desktop
          only — web has no local engine. */}
      {canTranscribeLocally && (
        <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-13 font-medium">{t("upload.mode_cloud")}</span>
            <span className="text-2xs leading-snug text-muted-foreground">
              {/* One line, always describing what the switch will do: on = the
                  audio leaves the device, off = it stays and only gets
                  transcribed here. */}
              {cloudLocked
                ? cloudLockReason
                : mode === "cloud"
                  ? t("upload.mode_cloud_desc")
                  : t("upload.mode_local_desc")}
            </span>
          </div>
          <Switch
            size="sm"
            className="mt-0.5"
            checked={mode === "cloud"}
            disabled={cloudLocked}
            onCheckedChange={(checked) => onModeChange(checked ? "cloud" : "local")}
            aria-label={t("upload.mode_cloud")}
          />
        </div>
      )}

      {/* Web has no local engine, so there is no mode selector to gray out — the
          entitlement has to be stated where the user would otherwise just find
          the button dead. */}
      {!canTranscribeLocally && cloudLocked && (
        <p className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {cloudLockReason}
        </p>
      )}

      {/* File picker drop zone */}
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 transition-colors cursor-pointer",
          dragOver
            ? "border-primary bg-primary/5"
            : "border-border/50 hover:border-border hover:bg-muted/30",
        )}
        onClick={onFileInputClick}
        onDrop={onDrop}
        onDragOver={offlineMode ? undefined : onDragOver}
        onDragLeave={onDragLeave}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES}
          className="hidden"
          onChange={onFileSelect}
        />
        {offlineMode && localAudioName ? (
          <>
            <FileAudio className="size-8 text-primary" />
            <p className="text-sm font-medium">{localAudioName}</p>
            <p className="text-xs text-muted-foreground">{t("upload.local_file_hint")}</p>
          </>
        ) : file ? (
          <>
            <FileAudio className="size-8 text-primary" />
            <p className="text-sm font-medium">{file.name}</p>
            <p className="text-xs text-muted-foreground">
              {formatFileSize(file.size)}
            </p>
          </>
        ) : (
          <>
            <Upload className="size-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              {offlineMode ? t("upload.local_pick_hint") : t("upload.drop_hint")}
            </p>
            <p className="text-xs text-muted-foreground/60">
              {offlineMode ? t("upload.local_format_hint") : t("upload.format_hint")}
            </p>
          </>
        )}
      </div>

      {/* Error message */}
      {phase === "error" && errorMsg && (
        <p className="text-sm text-destructive">{errorMsg}</p>
      )}

      {offlineMode && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t("upload.expected_speakers")}
              <input
                value={expectedSpeakers}
                onChange={(event) => onExpectedSpeakersChange(event.target.value.replace(/[^\d]/g, ""))}
                placeholder={t("upload.expected_speakers_auto")}
                inputMode="numeric"
                className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              {t("upload.hotword_package")}
              <select
                value={selectedHotwordPackageId}
                onChange={(event) => onHotwordPackageSelect(event.target.value)}
                className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary"
              >
                <option value="">{t("upload.hotword_none")}</option>
                {hotwordPackages.filter((pkg) => pkg.enabled).map((pkg) => (
                  <option key={pkg.id} value={pkg.id}>{pkg.name}</option>
                ))}
              </select>
            </label>
          </div>
          {/* The dialog closes on submit, so say where the work goes. */}
          <p className="text-xs leading-snug text-muted-foreground">
            {t("upload.local_background_hint")}
          </p>
        </div>
      )}
    </div>
  );
}



// ── Progress state content ──

function ProgressContent({
  phase,
  uploadPct,
  fileName,
}: {
  phase: UploadPhase;
  uploadPct: number;
  fileName: string;
}) {
  const { t } = useTranslation();

  // Cloud path only: a local import closes this dialog the moment the job is
  // queued and reports through the notes list instead.
  const steps = [
    { key: "uploading", label: t("upload.phase_uploading"), pct: phase === "uploading" ? uploadPct : phase === "transcribing" || phase === "summarizing" || phase === "complete" ? 100 : 0 },
    { key: "transcribing", label: t("upload.phase_transcribing"), pct: -1 },
    { key: "summarizing", label: t("upload.phase_summarizing"), pct: -1 },
  ];

  const phaseOrder = ["uploading", "transcribing", "summarizing", "complete"];
  const currentIdx = phaseOrder.indexOf(phase);

  return (
    <div className="flex flex-col gap-4 py-2">
      <p className="text-sm font-medium truncate">{fileName}</p>
      <div className="flex flex-col gap-3">
        {steps.map((step, i) => {
          const done = currentIdx > i || phase === "complete";
          const active = currentIdx === i && phase !== "complete";
          return (
            <div key={step.key} className="flex items-center gap-3">
              <div className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full transition-colors",
                done ? "bg-primary text-primary-foreground" : active ? "bg-primary/10" : "bg-muted",
              )}>
                <IconSwap stateKey={done ? "done" : active ? "active" : `pending-${i}`}>
                  {done ? (
                    <Check className="size-3.5" />
                  ) : active ? (
                    <Loader2 className="size-3.5 animate-spin text-primary" />
                  ) : (
                    <span className="text-xs text-muted-foreground">{i + 1}</span>
                  )}
                </IconSwap>
              </div>
              <div className="flex-1 min-w-0">
                <p className={cn(
                  "text-sm",
                  done ? "text-foreground" : active ? "text-foreground font-medium" : "text-muted-foreground",
                )}>
                  {step.label}
                </p>
                {step.pct >= 0 && active && (
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-300"
                      style={{ width: `${step.pct}%` }}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {phase === "complete" && (
        <div className="flex items-center gap-2 text-sm text-primary">
          <Check className="size-4" />
          {t("upload.complete")}
        </div>
      )}
    </div>
  );
}

// ── Helpers ──

/** Desktop imports default to on-device transcription; cloud is the explicit
 *  opt-out. Reads the same key the settings toggle writes, and the last choice
 *  made in this dialog, so the two never disagree. */
function prefersLocalByDefault(): boolean {
  if (typeof window === "undefined") return false;
  if (!getDesktopLocalTranscriptionApi()) return false;
  return localStorage.getItem(OFFLINE_TRANSCRIPTION_ENABLED_KEY) !== "0";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
