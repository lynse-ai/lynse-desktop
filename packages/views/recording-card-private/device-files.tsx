"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@lynse/ui/components/ui/alert-dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Checkbox } from "@lynse/ui/components/ui/checkbox";
import { Input } from "@lynse/ui/components/ui/input";
import { Progress } from "@lynse/ui/components/ui/progress";
import {
  ArrowLeft,
  ChevronRight,
  Clock,
  Download,
  Loader2,
  RefreshCw,
  Search,
} from "../icons";
import { recordingCardDisplayName, recordingCardDuration, recordingCardRecordableTime } from "./file-name";
import type { RecordingCardFile, RecordingCardSessionView } from "./transport";

type SortKey = "newest" | "oldest" | "name" | "size";

export function DeviceFiles({
  session,
  onBack,
  formatBytes,
}: {
  session: RecordingCardSessionView;
  onBack: () => void;
  formatBytes: (bytes: number) => string;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("newest");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBatch, setConfirmBatch] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [batchDownloading, setBatchDownloading] = useState(false);
  const cancelBatchRef = useRef(false);

  useEffect(() => {
    const names = new Set(session.files.map((file) => file.name));
    setSelected((current) => {
      const next = new Set([...current].filter((name) => names.has(name)));
      return next.size === current.size ? current : next;
    });
  }, [session.files]);

  const files = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = session.files.filter(
      (file) =>
        !needle ||
        file.name.toLowerCase().includes(needle) ||
        recordingCardDisplayName(file).toLowerCase().includes(needle),
    );
    return [...filtered].sort((a, b) => {
      if (sort === "oldest") return a.startTime - b.startTime;
      if (sort === "name") return recordingCardDisplayName(a).localeCompare(recordingCardDisplayName(b));
      if (sort === "size") return b.size - a.size;
      return b.startTime - a.startTime;
    });
  }, [session.files, query, sort]);

  const allVisibleSelected = files.length > 0 && files.every((file) => selected.has(file.name));
  const selectedNames = [...selected];
  const freeBytes = (session.storage?.freeSpace ?? 0) * 1024;
  const recordable = recordingCardRecordableTime(freeBytes, session.files);

  const toggleVisible = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const file of files) next.delete(file.name);
      } else {
        for (const file of files) next.add(file.name);
      }
      return next;
    });
  };

  const toggleFile = (name: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleSingleDelete = (file: RecordingCardFile) => {
    if (confirmingDelete !== file.name) {
      setConfirmingDelete(file.name);
      return;
    }
    setConfirmingDelete(null);
    session.deleteFile(file.name);
  };

  const handleBatchDelete = async () => {
    const names = selectedNames;
    setConfirmBatch(false);
    if (await session.deleteFiles(names)) setSelected(new Set());
  };

  const handleBatchDownload = async () => {
    const targets = files.filter((f) => selected.has(f.name));
    if (targets.length === 0) return;
    setBatchDownloading(true);
    cancelBatchRef.current = false;
    for (const file of targets) {
      if (cancelBatchRef.current) break;
      const res = await session.downloadFile(file);
      if (res === null) break;
    }
    setBatchDownloading(false);
  };

  return (
    <div className="space-y-4">
      {/* Page Header / Breadcrumb navigation */}
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          className="-ml-2 h-8 gap-1.5 px-2.5 text-xs text-muted-foreground hover:text-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" />
          <span>{t("recordingCard.overview_title")}</span>
        </Button>
        <ChevronRight className="size-3 text-muted-foreground/40" />
        <div className="flex items-center gap-1.5 pl-0.5">
          <span className="text-sm font-medium text-foreground">
            {t("recordingCard.files_view_title")}
          </span>
          <span className="text-xs text-muted-foreground">
            ({session.files.length})
          </span>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">

          <div className="rounded-lg bg-muted/40 p-3">
            <p className="text-xs text-muted-foreground">
              {t("recordingCard.recordable_title")}
            </p>
            <p className="mt-0.5 text-sm font-medium">
              {recordable
                ? t("recordingCard.recordable_value", {
                    hours: recordable.hours,
                    minutes: recordable.minutes,
                  })
                : t("recordingCard.recordable_empty")}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-40 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("recordingCard.search_placeholder")}
                className="h-8 pl-7 text-xs"
                aria-label={t("recordingCard.search_placeholder")}
              />
            </div>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
              className="h-8 rounded-md border border-input bg-background px-2.5 text-xs text-foreground"
              aria-label={t("recordingCard.sort_label")}
            >
              <option value="newest">{t("recordingCard.sort_newest")}</option>
              <option value="oldest">{t("recordingCard.sort_oldest")}</option>
              <option value="name">{t("recordingCard.sort_name")}</option>
              <option value="size">{t("recordingCard.sort_size")}</option>
            </select>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2.5 text-xs"
              onClick={session.refreshFiles}
              disabled={session.downloading}
            >
              <RefreshCw className="size-3.5" />
              {t("recordingCard.refresh")}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <button
              type="button"
              className="flex items-center gap-2 text-xs text-muted-foreground"
              onClick={toggleVisible}
            >
              <Checkbox checked={allVisibleSelected} aria-label={t("recordingCard.select_all")} />
              {allVisibleSelected ? t("recordingCard.clear_selection") : t("recordingCard.select_all")}
            </button>
            {selectedNames.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {t("recordingCard.selected_count", { count: selectedNames.length })}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                size="sm"
                variant="outline"
                className="h-8 px-3 text-xs"
                disabled={selectedNames.length === 0 || session.downloading || batchDownloading}
                onClick={handleBatchDownload}
              >
                {batchDownloading ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {t("recordingCard.download_selected")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="h-8 px-3 text-xs"
                disabled={selectedNames.length === 0 || session.downloading || session.settingsLoading || batchDownloading}
                onClick={() => setConfirmBatch(true)}
              >
                {session.settingsLoading ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t("recordingCard.delete_selected")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
          <CardTitle className="text-xs">
            {t("recordingCard.files_title")}
            <span className="ml-2 font-normal text-muted-foreground">
              {query.trim()
                ? `(${files.length}/${session.files.length})`
                : t("recordingCard.files_count", { count: files.length })}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {session.download && (
            <div className="rounded-md border bg-muted/30 p-2.5">
              <div className="mb-1.5 flex items-center justify-between text-xs">
                <span className="truncate font-medium">{session.download.fileName}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-muted-foreground">
                    {t("recordingCard.download_progress", {
                      percent:
                        session.download.total > 0
                          ? Math.min(
                              100,
                              Math.round((session.download.loaded / session.download.total) * 100),
                            )
                          : 0,
                    })}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      cancelBatchRef.current = true;
                      void session.cancelDownload();
                    }}
                  >
                    {t("recordingCard.download_cancel")}
                  </Button>
                </div>
              </div>
              <Progress
                value={
                  session.download.total > 0
                    ? Math.min(100, (session.download.loaded / session.download.total) * 100)
                    : 0
                }
              />
            </div>
          )}

          {session.listError && (
            <p className="text-xs text-destructive">{t("recordingCard.list_failed")}</p>
          )}

          {files.length === 0 && !session.listError ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              {t("recordingCard.no_results")}
            </p>
          ) : (
            files.map((file) => (
              <div
                key={file.sn}
                className="flex items-center gap-2.5 rounded-md border bg-background p-2.5"
              >
                <Checkbox
                  checked={selected.has(file.name)}
                  onCheckedChange={() => toggleFile(file.name)}
                  disabled={session.downloading}
                  aria-label={recordingCardDisplayName(file)}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">{recordingCardDisplayName(file)}</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{formatBytes(file.size)}</span>
                    <FileDuration
                      file={file}
                      durationLabel={(value) => t("recordingCard.duration", { duration: value })}
                    />
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-2.5 text-xs"
                  onClick={() => session.downloadFile(file)}
                  disabled={session.downloading}
                >
                  <Download className="size-3.5" />
                  {t("recordingCard.download")}
                </Button>
                <Button
                  size="sm"
                  variant={confirmingDelete === file.name ? "destructive" : "ghost"}
                  className="h-8 px-2.5 text-xs"
                  onClick={() => handleSingleDelete(file)}
                  onBlur={() => setConfirmingDelete(null)}
                  disabled={session.downloading || session.settingsLoading}
                >
                  {confirmingDelete === file.name
                    ? t("recordingCard.delete_confirm")
                    : t("recordingCard.delete")}
                </Button>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirmBatch} onOpenChange={setConfirmBatch}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("recordingCard.delete_selected_confirm_title", { count: selectedNames.length })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("recordingCard.delete_selected_confirm_desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm" className="h-8 text-xs">
              {t("recordingCard.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              className="h-8 text-xs"
              onClick={() => void handleBatchDelete()}
            >
              {t("recordingCard.delete_selected_confirm_action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FileDuration({
  file,
  durationLabel,
}: {
  file: RecordingCardFile;
  durationLabel: (duration: string) => string;
}) {
  const duration = recordingCardDuration(file);
  if (!duration) return null;
  const label = durationLabel(duration);
  return (
    <span className="inline-flex items-center gap-1" role="img" title={label} aria-label={label}>
      <Clock className="size-3 shrink-0" aria-hidden="true" />
      <span>{duration}</span>
    </span>
  );
}
