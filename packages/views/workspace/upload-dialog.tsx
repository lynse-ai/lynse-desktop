"use client";

import { useState, useCallback, useRef, useMemo, useEffect } from "react";
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
import { useTranslation } from "@lynse/core/i18n/react";
import { Upload, Loader2, Check, FileAudio, Sparkles } from "../icons";
import { cn } from "@lynse/ui/lib/utils";
import {
  useTemplateCategories,
  useTransferFile,
  waitForTranscriptionCompletion,
  uploadFileToOSS,
} from "./hooks/use-files";
import { useQueryClient } from "@tanstack/react-query";
import type { PromptTemplate, UploadPhase } from "./types";
import type { LocalHotwordPackage } from "./types";
import { TemplateSelector } from "./template-selector";
import {
  getDesktopLocalTranscriptionApi,
  OFFLINE_TRANSCRIPTION_ENABLED_KEY,
  resolveSttProvider,
  findModelStatus,
} from "./local-transcription";
import { isInsufficientCreditsError } from "../layout/use-user-credits";

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
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [phase, setPhase] = useState<UploadPhase>("idle");
  const [uploadPct, setUploadPct] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [offlineMode, setOfflineMode] = useState(false);
  const [expectedSpeakers, setExpectedSpeakers] = useState("");
  const [selectedHotwordPackageId, setSelectedHotwordPackageId] = useState("");
  const [hotwordPackages, setHotwordPackages] = useState<LocalHotwordPackage[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: categories } = useTemplateCategories();
  const transferFile = useTransferFile();

  // Flat list of all templates for selection
  const allTemplates = useMemo(() => {
    if (!categories) return [];
    return categories.flatMap((c) => c.templates);
  }, [categories]);

  // Auto-select default template
  const defaultTemplate = useMemo(() => {
    return allTemplates.find((t) => t.isDefault === 1) ?? allTemplates[0];
  }, [allTemplates]);

  // Ensure a template is selected
  const effectiveTemplateId = selectedTemplateId || defaultTemplate?.id || "";
  const localApi = getDesktopLocalTranscriptionApi();
  const useOfflineTranscription = offlineMode && !!localApi;
  const localAudioName = localAudioPath ? localAudioPath.split(/[\\/]/).pop() ?? localAudioPath : "";
  const selectedFileName = useOfflineTranscription ? localAudioName : file?.name ?? "";
  const hasSelectedSource = useOfflineTranscription ? !!localAudioPath : !!file;

  const isProcessing = phase !== "idle" && phase !== "complete" && phase !== "error";

  useEffect(() => {
    if (!open) return;
    setOfflineMode(localStorage.getItem(OFFLINE_TRANSCRIPTION_ENABLED_KEY) === "1");
    getDesktopLocalTranscriptionApi()?.listHotwordPackages()
      .then(setHotwordPackages)
      .catch(() => setHotwordPackages([]));
  }, [open]);

  const reset = useCallback(() => {
    setFile(null);
    setLocalAudioPath(null);
    setSelectedTemplateId("");
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
    if (!useOfflineTranscription && (!file || !effectiveTemplateId)) return;
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
        setPhase("transcribing");
        const expectedSpeakersValue = Number.parseInt(expectedSpeakers, 10);
        const record = await localApi.transcribe(localAudioPath, {
          expectedSpeakers: Number.isFinite(expectedSpeakersValue) && expectedSpeakersValue > 0
            ? expectedSpeakersValue
            : undefined,
          hotwordPackageId: selectedHotwordPackageId || undefined,
        });
        setPhase("complete");
        toast.success(t("upload.local_success"));
        qc.invalidateQueries({ queryKey: ["files"] });
        qc.invalidateQueries({ queryKey: ["file-transcription", record.id] });
        setTimeout(() => {
          reset();
          onOpenChange(false);
        }, 1500);
        return;
      }

      if (!file) return;
      // Phase 1: Upload to OSS
      setPhase("uploading");
      setUploadPct(0);
      const fileId = await uploadFileToOSS(file, (pct) => setUploadPct(pct));

      // Phase 2: Trigger transcription + summarization
      setPhase("transcribing");
      await transferFile.mutateAsync({
        fileId,
        templateId: effectiveTemplateId,
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
  }, [file, effectiveTemplateId, transferFile, qc, t, reset, onOpenChange, hasSelectedSource, localApi, localAudioPath, useOfflineTranscription, expectedSpeakers, selectedHotwordPackageId]);

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("upload.title")}</DialogTitle>
          <DialogDescription>{t("upload.description")}</DialogDescription>
        </DialogHeader>

        {phase === "idle" || phase === "error" ? (
          <IdleContent
            file={file}
            localAudioName={localAudioName}
            offlineMode={useOfflineTranscription}
            phase={phase}
            errorMsg={errorMsg}
            dragOver={dragOver}
            categories={categories ?? []}
            selectedTemplateId={effectiveTemplateId}
            expectedSpeakers={expectedSpeakers}
            hotwordPackages={hotwordPackages}
            selectedHotwordPackageId={selectedHotwordPackageId}
            onFileSelect={handleFileSelect}
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onTemplateSelect={setSelectedTemplateId}
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
            offlineMode={useOfflineTranscription}
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
                disabled={!hasSelectedSource || (!useOfflineTranscription && !effectiveTemplateId) || phase === "error" && !hasSelectedSource}
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

// ── Idle state content: file picker + template selector ──

interface IdleContentProps {
  file: File | null;
  localAudioName: string;
  offlineMode: boolean;
  phase: UploadPhase;
  errorMsg: string;
  dragOver: boolean;
  categories: { category: string; templates: PromptTemplate[] }[];
  selectedTemplateId: string;
  expectedSpeakers: string;
  hotwordPackages: LocalHotwordPackage[];
  selectedHotwordPackageId: string;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onTemplateSelect: (id: string) => void;
  onExpectedSpeakersChange: (value: string) => void;
  onHotwordPackageSelect: (id: string) => void;
  onFileInputClick: () => void | Promise<void>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
}

function IdleContent({
  file,
  localAudioName,
  offlineMode,
  phase,
  errorMsg,
  dragOver,
  categories,
  selectedTemplateId,
  expectedSpeakers,
  hotwordPackages,
  selectedHotwordPackageId,
  onFileSelect,
  onDrop,
  onDragOver,
  onDragLeave,
  onTemplateSelect,
  onExpectedSpeakersChange,
  onHotwordPackageSelect,
  onFileInputClick,
  fileInputRef,
}: IdleContentProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
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

      {!offlineMode && (
        <TemplateSelector
          categories={categories}
          selectedId={selectedTemplateId}
          onSelect={onTemplateSelect}
          scrollHeight="h-56"
        />
      )}

      {offlineMode && (
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            预计发言人数
            <input
              value={expectedSpeakers}
              onChange={(event) => onExpectedSpeakersChange(event.target.value.replace(/[^\d]/g, ""))}
              placeholder="自动"
              inputMode="numeric"
              className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            热词包
            <select
              value={selectedHotwordPackageId}
              onChange={(event) => onHotwordPackageSelect(event.target.value)}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary"
            >
              <option value="">不使用</option>
              {hotwordPackages.filter((pkg) => pkg.enabled).map((pkg) => (
                <option key={pkg.id} value={pkg.id}>{pkg.name}</option>
              ))}
            </select>
          </label>
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
  offlineMode,
}: {
  phase: UploadPhase;
  uploadPct: number;
  fileName: string;
  offlineMode: boolean;
}) {
  const { t } = useTranslation();

  const steps = offlineMode ? [
    { key: "transcribing", label: t("upload.phase_local_transcribing"), pct: -1 },
  ] as const : [
    { key: "uploading", label: t("upload.phase_uploading"), pct: phase === "uploading" ? uploadPct : phase === "transcribing" || phase === "summarizing" || phase === "complete" ? 100 : 0 },
    { key: "transcribing", label: t("upload.phase_transcribing"), pct: -1 },
    { key: "summarizing", label: t("upload.phase_summarizing"), pct: -1 },
  ] as const;

  const phaseOrder = offlineMode ? ["transcribing", "complete"] : ["uploading", "transcribing", "summarizing", "complete"];
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
                {done ? (
                  <Check className="size-3.5" />
                ) : active ? (
                  <Loader2 className="size-3.5 animate-spin text-primary" />
                ) : (
                  <span className="text-xs text-muted-foreground">{i + 1}</span>
                )}
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
                      className="h-full rounded-full bg-primary transition-all duration-300"
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
