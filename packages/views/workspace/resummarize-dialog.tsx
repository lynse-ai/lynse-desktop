"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
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
import { Input } from "@lynse/ui/components/ui/input";
import { Label } from "@lynse/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lynse/ui/components/ui/select";
import { Trash2 } from "../icons";
import { useTranslation } from "@lynse/core/i18n/react";
import { useAddSummary, useReplaceSummaryTemplate, useRerunSummary, useTemplateCategories, useFileDetail } from "./hooks/use-files";
import { isInsufficientCreditsError } from "../layout/use-user-credits";
import { isLynclawSummaryTabsEnabled } from "../feature-flags";
import { LYNCLAW_FORMAT_LABELS } from "./lynclaw-notes";
import type { LynclawSummaryFormat } from "./lynclaw-summary";
import type { FileConclusion, PromptTemplate } from "./types";
import { useQueryClient } from "@tanstack/react-query";
import { TemplateSelector } from "./template-selector";
import {
  getCustomModelsApi,
  getCustomModel,
  isValidTemplatePrompt,
  loadCustomModels,
  loadCustomTemplates,
  removeCustomTemplate,
  saveCustomTemplate,
  type CustomModelProfile,
  type CustomSummaryTemplate,
} from "../custom-models";

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
  /**
   * Local recordings: with this prop the dialog switches to the fully
   * off-cloud section — the user's own template plus their own custom model,
   * called directly from the desktop. Cloud template categories are hidden.
   */
  localOnly?: boolean;
  onCustomModelApply?: (
    fileId: string,
    options: { prompt: string; profileId: string; templateName: string },
  ) => Promise<void>;
}

/** Last-used custom model for local summaries, so the picker opens sensibly. */
const LAST_CUSTOM_MODEL_KEY = "lynse_custom_summary_profile";

export function ResummarizeDialog({ open, onOpenChange, fileId, conclusionId, mode, onStarted, onFinished, onLynclawApply, localOnly, onCustomModelApply }: ResummarizeDialogProps) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  // Off-cloud mode never queries the cloud template list.
  const { data: categories } = useTemplateCategories(!localOnly);
  const { data: fileDetail } = useFileDetail(fileId);
  const addSummary = useAddSummary();
  const rerunSummary = useRerunSummary();
  const replaceSummary = useReplaceSummaryTemplate();

  const [selectedId, setSelectedId] = useState<string>("");

  // Off-cloud section (local recordings): the user's own template + model.
  const customEnabled = !!localOnly && !!onCustomModelApply && !!getCustomModelsApi();
  const [customProfiles, setCustomProfiles] = useState<CustomModelProfile[]>([]);
  const [customTemplates, setCustomTemplates] = useState<CustomSummaryTemplate[]>([]);
  const [customProfileId, setCustomProfileId] = useState("");
  const [customTemplateId, setCustomTemplateId] = useState("");
  const [customName, setCustomName] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");
  const [customBusy, setCustomBusy] = useState(false);
  const [customError, setCustomError] = useState<{ title: string; description: string } | null>(null);
  const customDialogOpen = useRef(false);
  useEffect(() => {
    customDialogOpen.current = open && customEnabled;
    return () => { customDialogOpen.current = false; };
  }, [open, customEnabled]);
  useEffect(() => {
    if (!open || !customEnabled) return;
    setCustomError(null);
    const profiles = loadCustomModels();
    setCustomProfiles(profiles);
    setCustomTemplates(loadCustomTemplates());
    const last = typeof localStorage === "undefined" ? null : localStorage.getItem(LAST_CUSTOM_MODEL_KEY);
    setCustomProfileId(profiles.some((profile) => profile.id === last) ? last! : profiles[0]?.id ?? "");
  }, [open, customEnabled]);

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

  // --- Off-cloud section (local recordings) --------------------------------

  const chooseCustomTemplate = useCallback((id: string) => {
    setCustomTemplateId(id);
    const template = loadCustomTemplates().find((entry) => entry.id === id);
    if (template) {
      setCustomName(template.name);
      setCustomPrompt(template.prompt);
    }
  }, []);

  const saveCurrentTemplate = useCallback(() => {
    const name = customName.trim();
    if (!name || !isValidTemplatePrompt(customPrompt)) return;
    const id = customTemplateId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setCustomTemplates(saveCustomTemplate({ id, name, prompt: customPrompt.trim(), createdAt: new Date().toISOString() }));
    setCustomTemplateId(id);
    toast.success(t("customModels.template_saved"));
  }, [customName, customPrompt, customTemplateId, t]);

  const handleCustomApply = useCallback(async () => {
    if (!fileId || !onCustomModelApply || !customProfileId || !isValidTemplatePrompt(customPrompt) || customBusy) return;
    const profile = getCustomModel(customProfileId);
    setCustomError(null);
    setCustomBusy(true);
    try {
      if (!profile) throw new Error("customModels.summary_no_profile");
      if (typeof localStorage !== "undefined") localStorage.setItem(LAST_CUSTOM_MODEL_KEY, customProfileId);
      await onCustomModelApply(fileId, {
        prompt: customPrompt.trim(),
        profileId: customProfileId,
        templateName: customName.trim() || profile.label,
      });
      toast.success(t("customModels.summary_generated", { model: profile.label }));
      onOpenChange(false);
    } catch (err) {
      const key = err instanceof Error ? err.message : "";
      const failure = {
        title: profile ? t("customModels.summary_failed_with_model", { model: profile.label }) : t("customModels.summary_failed"),
        description: key.startsWith("customModels.") && i18n.exists(key)
          ? t(key)
          : t("customModels.summary_retry"),
      };
      if (customDialogOpen.current) setCustomError(failure);
      else toast.error(failure.title, { description: failure.description });
    } finally {
      setCustomBusy(false);
    }
  }, [fileId, onCustomModelApply, customProfileId, customPrompt, customName, customBusy, onOpenChange, t, i18n]);

  const customModel = customProfiles.find((profile) => profile.id === customProfileId);

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

        {/* Template list — off-cloud mode swaps in the custom-template editor */}
        {customEnabled ? (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-muted-foreground">{t("customModels.summary_section_hint")}</p>
            {customTemplates.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="custom-template-pick" className="text-xs text-muted-foreground">{t("customModels.template_label")}</Label>
                <div className="flex gap-2">
                  <Select
                    value={customTemplateId}
                    items={Object.fromEntries(customTemplates.map((template) => [template.id, template.name]))}
                    onValueChange={(id) => { if (id !== null) chooseCustomTemplate(id); }}
                  >
                    <SelectTrigger id="custom-template-pick" className="h-9 flex-1 text-xs"><SelectValue placeholder={t("customModels.template_label")} /></SelectTrigger>
                    <SelectContent>
                      {customTemplates.map((template) => (
                        <SelectItem key={template.id} value={template.id}>{template.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {customTemplateId && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-9 shrink-0"
                      aria-label={t("customModels.delete")}
                      onClick={() => {
                        setCustomTemplates(removeCustomTemplate(customTemplateId));
                        setCustomTemplateId("");
                      }}
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="custom-template-name" className="text-xs text-muted-foreground">{t("customModels.template_name_label")}</Label>
              <Input
                id="custom-template-name"
                className="h-9 text-xs"
                placeholder={t("customModels.template_name_placeholder")}
                value={customName}
                onChange={(event) => setCustomName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="custom-template-prompt" className="text-xs text-muted-foreground">{t("customModels.template_label")}</Label>
              <textarea
                id="custom-template-prompt"
                className="min-h-32 w-full rounded-md border border-input bg-background p-2 text-sm leading-relaxed"
                spellCheck={false}
                value={customPrompt}
                onChange={(event) => setCustomPrompt(event.target.value)}
              />
              <Button type="button" size="sm" variant="ghost" disabled={!isValidTemplatePrompt(customPrompt) || !customName.trim()} onClick={saveCurrentTemplate}>
                {t("customModels.save_template")}
              </Button>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="custom-model-pick" className="text-xs text-muted-foreground">{t("customModels.use_model")}</Label>
              <Select
                value={customProfileId}
                items={Object.fromEntries(customProfiles.map((profile) => [profile.id, `${profile.label} · ${profile.model}`]))}
                onValueChange={(id) => {
                  setCustomProfileId(id ?? "");
                  setCustomError(null);
                }}
                disabled={!customProfiles.length || customBusy}
              >
                <SelectTrigger id="custom-model-pick" className="h-9 text-xs"><SelectValue placeholder={t("customModels.empty")} /></SelectTrigger>
                <SelectContent>
                  {customProfiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>{profile.label} · {profile.model}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!customProfiles.length && <p className="text-2xs leading-relaxed text-muted-foreground">{t("customModels.empty")}</p>}
              {customError && (
                <div role="alert" className="text-xs leading-relaxed text-destructive">
                  <p className="font-medium">{customError.title}</p>
                  <p>{customError.description}</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <TemplateSelector
            categories={allCategories}
            selectedId={effectiveId}
            onSelect={setSelectedId}
            scrollHeight="h-72"
          />
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>
            {text("resummarize.cancel", fallback.cancel)}
          </Button>
          {customEnabled ? (
            <Button onClick={() => void handleCustomApply()} disabled={customBusy || !customProfileId || !isValidTemplatePrompt(customPrompt)}>
              {customBusy && customModel
                ? t("customModels.summary_generating", { model: customModel.label })
                : text("resummarize.apply", fallback.apply)}
            </Button>
          ) : (
            <Button onClick={handleApply} disabled={!effectiveId || (mode === "replace" && !conclusionId)}>
              {text("resummarize.apply", fallback.apply)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
