"use client";

import { useState, useCallback, useMemo } from "react";
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
import { useAddSummary, useReplaceSummaryTemplate, useRerunSummary, useTemplateCategories, useFileDetail } from "./hooks/use-files";
import type { FileConclusion } from "./types";
import { useQueryClient } from "@tanstack/react-query";
import { TemplateSelector } from "./template-selector";

export type SummaryTemplateDialogMode = "add" | "rerun" | "replace";

const FALLBACK_TEXT = {
  en: {
    addTitle: "Add summary",
    addDescription: "Select a template to add a new summary from the existing transcript",
    rerunTitle: "Re-summarize",
    rerunDescription: "Select a template to process the file again and regenerate its summary",
    replaceTitle: "Change summary template",
    replaceDescription: "Select a template to replace this summary",
    cancel: "Cancel",
    apply: "Generate",
    addSuccess: "New summary generated",
    addFailed: "Add summary failed",
    rerunSuccess: "Summary regenerated",
    rerunFailed: "Re-summarization failed",
    replaceSuccess: "Summary template changed",
    replaceFailed: "Template change failed",
    unknownError: "Unknown error",
  },
  "zh-Hans": {
    addTitle: "添加总结",
    addDescription: "选择模板，基于现有转写内容新增一份总结",
    rerunTitle: "重新总结",
    rerunDescription: "选择模板，重新处理文件并生成总结",
    replaceTitle: "更换总结模板",
    replaceDescription: "选择模板，替换当前这条总结",
    cancel: "取消",
    apply: "生成",
    addSuccess: "新总结已生成",
    addFailed: "添加总结失败",
    rerunSuccess: "总结已重新生成",
    rerunFailed: "重新总结失败",
    replaceSuccess: "总结模板已更换",
    replaceFailed: "更换模板失败",
    unknownError: "未知错误",
  },
  ja: {
    addTitle: "要約を追加",
    addDescription: "既存の文字起こしから新しい要約を追加するテンプレートを選択します",
    rerunTitle: "再要約",
    rerunDescription: "テンプレートを選択し、ファイルを再処理して要約を生成します",
    replaceTitle: "要約テンプレートを変更",
    replaceDescription: "テンプレートを選択してこの要約を置き換えます",
    cancel: "キャンセル",
    apply: "生成",
    addSuccess: "新しい要約を生成しました",
    addFailed: "要約の追加に失敗しました",
    rerunSuccess: "要約を再生成しました",
    rerunFailed: "再要約に失敗しました",
    replaceSuccess: "要約テンプレートを変更しました",
    replaceFailed: "テンプレートの変更に失敗しました",
    unknownError: "不明なエラー",
  },
} as const;

function getFallbackLanguage(language: string | undefined): keyof typeof FALLBACK_TEXT {
  if (language?.startsWith("zh")) return "zh-Hans";
  if (language?.startsWith("ja")) return "ja";
  return "en";
}

interface ResummarizeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileId: string | null;
  conclusionId?: string | null;
  mode: SummaryTemplateDialogMode;
  onStarted?: (
    fileId: string,
    mode: SummaryTemplateDialogMode,
    options?: { pendingId?: string; templateName?: string },
  ) => void;
  onFinished?: (
    fileId: string,
    success: boolean,
    mode: SummaryTemplateDialogMode,
    options?: { pendingId?: string; conclusion?: FileConclusion },
  ) => void;
}

export function ResummarizeDialog({ open, onOpenChange, fileId, conclusionId, mode, onStarted, onFinished }: ResummarizeDialogProps) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data: categories } = useTemplateCategories();
  const { data: fileDetail } = useFileDetail(fileId);
  const addSummary = useAddSummary();
  const rerunSummary = useRerunSummary();
  const replaceSummary = useReplaceSummaryTemplate();

  const [selectedId, setSelectedId] = useState<string>("");

  // Flat list + default template
  const allTemplates = useMemo(() => {
    if (!categories) return [];
    return categories.flatMap((c) => c.templates);
  }, [categories]);

  const defaultTemplate = useMemo(() => {
    return allTemplates.find((tpl) => tpl.isDefault === 1) ?? allTemplates[0];
  }, [allTemplates]);

  const effectiveId = selectedId || defaultTemplate?.id || "";
  const fallback = FALLBACK_TEXT[getFallbackLanguage(i18n.language)];
  const text = useCallback(
    (key: string, fallbackValue: string) => {
      const translated = t(key);
      return translated === key ? fallbackValue : translated;
    },
    [t],
  );

  const handleApply = useCallback(async () => {
    if (!fileId || !effectiveId || (mode === "replace" && !conclusionId)) return;
    const currentFileId = fileId;
    const currentConclusionId = conclusionId;
    const currentTemplateId = effectiveId;
    const currentMode = mode;
    const currentTemplateName = allTemplates.find((tpl) => tpl.id === currentTemplateId)?.name ?? "";
    const pendingId =
      currentMode === "add"
        ? `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
        : undefined;
    onStarted?.(currentFileId, currentMode, { pendingId, templateName: currentTemplateName });
    onOpenChange(false);
    setSelectedId("");
    if (currentMode === "rerun") {
      qc.setQueryData(["file-conclusions", currentFileId], []);
    }
    try {
      let conclusion: FileConclusion | undefined;
      if (currentMode === "add") {
        const result = await addSummary.mutateAsync({
          aiTaskType: "CONCLUSION",
          fileId: currentFileId,
          templateId: currentTemplateId,
        });
        conclusion = result.conclusion;
      } else if (currentMode === "replace" && currentConclusionId) {
        await replaceSummary.mutateAsync({
          fileId: currentFileId,
          oldConclusionId: currentConclusionId,
          templateId: currentTemplateId,
        });
      } else {
        const result = await rerunSummary.mutateAsync({
          fileId: currentFileId,
          templateId: currentTemplateId,
          modelId: (fileDetail as Record<string, unknown> | undefined)?.modelId as string | undefined,
          languageId: (fileDetail as Record<string, unknown> | undefined)?.languageId as string | undefined,
        });
        conclusion = result.conclusion;
      }
      toast.success(
        currentMode === "add"
          ? text("add_summary.success", fallback.addSuccess)
          : currentMode === "replace"
            ? text("summary_tab.replace_success", fallback.replaceSuccess)
          : text("resummarize.success", fallback.rerunSuccess),
      );
      onFinished?.(currentFileId, true, currentMode, { pendingId, conclusion });
      if (currentMode !== "rerun" || !conclusion) {
        await qc.invalidateQueries({ queryKey: ["file-conclusions", currentFileId] });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : text("resummarize.unknown_error", fallback.unknownError);
      toast.error(
        currentMode === "add"
          ? text("add_summary.failed", fallback.addFailed)
          : currentMode === "replace"
            ? text("summary_tab.replace_failed", fallback.replaceFailed)
          : text("resummarize.failed", fallback.rerunFailed),
        { description: msg },
      );
      onFinished?.(currentFileId, false, currentMode, { pendingId });
    }
  }, [fileId, effectiveId, mode, conclusionId, allTemplates, onStarted, onOpenChange, qc, addSummary, replaceSummary, rerunSummary, text, fallback, onFinished]);

  const handleClose = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen) setSelectedId("");
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "add"
              ? text("add_summary.title", fallback.addTitle)
              : mode === "replace"
                ? text("summary_tab.replace_template", fallback.replaceTitle)
              : text("resummarize.title", fallback.rerunTitle)}
          </DialogTitle>
          <DialogDescription>
            {mode === "add"
              ? text("add_summary.description", fallback.addDescription)
              : mode === "replace"
                ? text("summary_tab.replace_description", fallback.replaceDescription)
              : text("resummarize.description", fallback.rerunDescription)}
          </DialogDescription>
        </DialogHeader>

        {/* Template list */}
        <TemplateSelector
          categories={categories ?? []}
          selectedId={effectiveId}
          onSelect={setSelectedId}
          scrollHeight="h-72"
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>
            {text("resummarize.cancel", fallback.cancel)}
          </Button>
          <Button onClick={handleApply} disabled={!effectiveId || (mode === "replace" && !conclusionId)}>
            {text("resummarize.apply", fallback.apply)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
