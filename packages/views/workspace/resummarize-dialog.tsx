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
import { isInsufficientCreditsError } from "../layout/use-user-credits";
import { isLynclawSummaryTabsEnabled } from "../feature-flags";
import { LYNCLAW_FORMAT_LABELS } from "./lynclaw-notes";
import type { LynclawSummaryFormat } from "./lynclaw-summary";
import type { FileConclusion, PromptTemplate } from "./types";
import { useQueryClient } from "@tanstack/react-query";
import { TemplateSelector } from "./template-selector";

export type SummaryTemplateDialogMode = "add" | "rerun" | "replace";

/**
 * Pseudo-template ids for the beta Lynclaw entries. Never sent to the server
 * task pipeline — handleApply routes them to the client-side generation that
 * inserts the result as a real conclusion (see onLynclawApply).
 */
const LYNCLAW_TEMPLATE_IDS = { markdown: "__lynclaw_markdown__", html: "__lynclaw_html__" } as const;

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
    creditsInsufficient: "Insufficient credits to process. Please recharge and try again.",
    lynclawHint: "Beta · Generated on-device from the transcript",
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
    creditsInsufficient: "积分不足，无法完成处理，请充值后重试",
    lynclawHint: "Beta · 客户端基于逐字稿直接生成",
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
    creditsInsufficient: "処理に必要なポイントが不足しています。チャージしてから再度お試しください。",
    lynclawHint: "Beta · 端末上で文字起こしから直接生成",
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
  /**
   * Beta Lynclaw entries: generate the summary client-side from the transcript
   * and insert it as a real cloud conclusion. Provided only while the feature
   * gate is unlocked; when absent the pseudo-templates are hidden entirely.
   */
  onLynclawApply?: (fileId: string, format: LynclawSummaryFormat) => Promise<FileConclusion>;
}

export function ResummarizeDialog({ open, onOpenChange, fileId, conclusionId, mode, onStarted, onFinished, onLynclawApply }: ResummarizeDialogProps) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const { data: categories } = useTemplateCategories();
  const { data: fileDetail } = useFileDetail(fileId);
  const addSummary = useAddSummary();
  const rerunSummary = useRerunSummary();
  const replaceSummary = useReplaceSummaryTemplate();

  const [selectedId, setSelectedId] = useState<string>("");

  const fallback = FALLBACK_TEXT[getFallbackLanguage(i18n.language)];
  const text = useCallback(
    (key: string, fallbackValue: string) => {
      const translated = t(key);
      return translated === key ? fallbackValue : translated;
    },
    [t],
  );

  const lynclawEnabled = isLynclawSummaryTabsEnabled() && !!onLynclawApply;
  const serverCategories = useMemo(() => categories ?? [], [categories]);

  // Beta Lynclaw pseudo-templates: generated from the transcript on-device and
  // inserted as real conclusions, so they sit alongside the server templates
  // and stay hidden entirely while the beta gate is locked.
  const lynclawTemplates = useMemo<PromptTemplate[]>(() => {
    if (!lynclawEnabled) return [];
    const hint = text("workspace.lynclaw_summary_beta_hint", fallback.lynclawHint);
    const label = t("workspace.lynclaw_summary");
    return (["markdown", "html"] as const).map((format) => ({
      id: LYNCLAW_TEMPLATE_IDS[format],
      name: `${label} · ${LYNCLAW_FORMAT_LABELS[format]}`,
      alias: hint === "workspace.lynclaw_summary_beta_hint" ? "" : hint,
      category: label,
      tags: "Beta",
      isDefault: 0,
      status: 1,
      sortOrder: 0,
      iconUrl: "",
      contentFormat: format,
    }));
  }, [lynclawEnabled, t, text, fallback]);

  // Flat list + default template
  const allCategories = useMemo(
    () => lynclawTemplates.length
      ? [...serverCategories, { category: lynclawTemplates[0]!.category, templates: lynclawTemplates }]
      : serverCategories,
    [serverCategories, lynclawTemplates],
  );
  const allTemplates = useMemo(() => allCategories.flatMap((c) => c.templates), [allCategories]);

  const defaultTemplate = useMemo(() => {
    // Default stays a server template — Lynclaw entries are opt-in additions.
    const serverTemplates = serverCategories.flatMap((c) => c.templates);
    return serverTemplates.find((tpl) => tpl.isDefault === 1) ?? serverTemplates[0] ?? lynclawTemplates[0];
  }, [serverCategories, lynclawTemplates]);

  const effectiveId = selectedId || defaultTemplate?.id || "";

  const handleApply = useCallback(async () => {
    if (!fileId || !effectiveId || (mode === "replace" && !conclusionId)) return;
    const currentFileId = fileId;
    const currentConclusionId = conclusionId;
    const currentTemplateId = effectiveId;
    const currentMode = mode;
    const currentTemplateName = allTemplates.find((tpl) => tpl.id === currentTemplateId)?.name ?? "";
    // Beta Lynclaw entries never reach the server task pipeline — they route
    // to the client-side generation + conclusion insert.
    const lynclawFormat: LynclawSummaryFormat | null = lynclawEnabled
      ? currentTemplateId === LYNCLAW_TEMPLATE_IDS.html
        ? "html"
        : currentTemplateId === LYNCLAW_TEMPLATE_IDS.markdown
          ? "markdown"
          : null
      : null;
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
      if (lynclawFormat) {
        conclusion = await onLynclawApply!(currentFileId, lynclawFormat);
      } else if (currentMode === "add") {
        const result = await addSummary.mutateAsync({
          aiTaskType: "CONCLUSION",
          fileId: currentFileId,
          templateId: currentTemplateId,
          modelId: (fileDetail as Record<string, unknown> | undefined)?.modelId as string | undefined,
          languageId: (fileDetail as Record<string, unknown> | undefined)?.languageId as string | undefined,
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
      const isCreditsError = isInsufficientCreditsError(err);
      const msg = err instanceof Error ? err.message : text("resummarize.unknown_error", fallback.unknownError);
      toast.error(
        isCreditsError
          ? text("resummarize.credits_insufficient", fallback.creditsInsufficient)
          : currentMode === "add"
            ? text("add_summary.failed", fallback.addFailed)
            : currentMode === "replace"
              ? text("summary_tab.replace_failed", fallback.replaceFailed)
              : text("resummarize.failed", fallback.rerunFailed),
        { description: isCreditsError ? undefined : msg },
      );
      onFinished?.(currentFileId, false, currentMode, { pendingId });
    }
  }, [fileId, effectiveId, mode, conclusionId, allTemplates, lynclawEnabled, onLynclawApply, onStarted, onOpenChange, qc, addSummary, replaceSummary, rerunSummary, text, fallback, onFinished]);

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
          categories={allCategories}
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
