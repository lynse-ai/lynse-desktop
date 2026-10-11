"use client";

import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@lynse/ui/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Label } from "@lynse/ui/components/ui/label";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  fetchModelPresets,
  isHttpUrl,
  loadChatModelSetting,
  saveChatModelSetting,
  type ChatModelSetting,
  type ModelPreset,
} from "./model-override";
import { Check, ChevronDown, Cpu } from "../icons";

/**
 * Composer model picker (bottom-right, left of the send button). Edits the
 * same locally persisted setting as the settings page's "对话模型" card and
 * affects the next sent turn.
 *
 * The menu shows model ids only — which preset serves a model is plumbing
 * the user does not care about — plus a "自定义模型…" entry that opens a
 * compact dialog for pointing at any OpenAI-compatible endpoint. Presets
 * load lazily on first open; a failed load only disables the served models,
 * never the custom entry.
 */
export function ChatModelPicker() {
  const { t } = useTranslation();
  const [setting, setSetting] = useState<ChatModelSetting>({ mode: "default" });
  const [presets, setPresets] = useState<ModelPreset[] | null>(null);
  const [presetsFailed, setPresetsFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState({ baseUrl: "", apiKey: "", model: "" });
  const [customError, setCustomError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    // Re-read on every open so changes made in the settings dialog land here.
    setSetting(loadChatModelSetting());
    if (presets === null && !presetsFailed) {
      fetchModelPresets()
        .then((list) => {
          setPresets(list);
          setPresetsFailed(false);
          // A model whose serving preset vanished degrades to the default
          // model instead of failing every future turn with a 400.
          const stored = loadChatModelSetting();
          if (stored.mode === "preset" && !list.some((p) => p.id === stored.presetId)) {
            saveChatModelSetting({ mode: "default" });
            setSetting({ mode: "default" });
          }
        })
        .catch(() => setPresetsFailed(true));
    }
  }

  function pickDefault() {
    saveChatModelSetting({ mode: "default" });
    setSetting({ mode: "default" });
  }

  function pickModel(model: string) {
    const serving = (presets ?? []).find((p) => p.models.includes(model));
    if (!serving) return;
    saveChatModelSetting({ mode: "preset", presetId: serving.id, model });
    setSetting({ mode: "preset", presetId: serving.id, model });
  }

  function openCustomDialog() {
    const stored = loadChatModelSetting();
    const draft =
      stored.mode === "custom"
        ? { baseUrl: stored.baseUrl, apiKey: stored.apiKey, model: stored.model }
        : { baseUrl: "", apiKey: "", model: "" };
    setCustomDraft(draft);
    setCustomError(null);
    setCustomOpen(true);
    setOpen(false);
  }

  function saveCustom() {
    const { baseUrl, apiKey, model } = customDraft;
    if (!baseUrl.trim() || !apiKey.trim() || !model.trim()) {
      setCustomError(t("settings.model_invalid_custom"));
      return;
    }
    if (!isHttpUrl(baseUrl.trim())) {
      setCustomError(t("settings.model_invalid_url"));
      return;
    }
    const next: ChatModelSetting = {
      mode: "custom",
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      model: model.trim(),
    };
    saveChatModelSetting(next);
    setSetting(next);
    setCustomOpen(false);
  }

  const triggerLabel =
    setting.mode === "default" ? t("chat.model_picker_default") : setting.model;

  // Served models flattened across presets, deduped by id (first preset wins) —
  // the serving preset is plumbing the user does not see.
  const servedModels: { model: string; presetId: string }[] = [];
  for (const preset of presets ?? []) {
    for (const model of preset.models) {
      if (!servedModels.some((entry) => entry.model === model)) {
        servedModels.push({ model, presetId: preset.id });
      }
    }
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger
          title={t("chat.model_picker_label")}
          aria-label={t("chat.model_picker_label")}
          className="flex h-7 max-w-48 shrink-0 items-center gap-1 rounded-md px-1.5 text-2xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-white/[0.06]"
        >
          <Cpu className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{triggerLabel}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="end" className="min-w-44 text-xs">
          <DropdownMenuItem className="gap-2 text-xs" onClick={pickDefault}>
            <span className="min-w-0 flex-1 truncate">{t("settings.model_mode_default")}</span>
            {setting.mode === "default" && <Check className="size-3.5 shrink-0 text-primary" />}
          </DropdownMenuItem>

          {presets === null && !presetsFailed && (
            <DropdownMenuItem disabled className="text-xs">
              {t("settings.model_presets_loading")}
            </DropdownMenuItem>
          )}
          {presetsFailed && (
            <DropdownMenuItem disabled className="text-xs">
              {t("settings.model_presets_failed")}
            </DropdownMenuItem>
          )}

          {servedModels.map(({ model }) => (
            <DropdownMenuItem
              key={model}
              className="gap-2 text-xs"
              onClick={() => pickModel(model)}
            >
              <span className="min-w-0 flex-1 truncate">{model}</span>
              {setting.mode === "preset" && setting.model === model && (
                <Check className="size-3.5 shrink-0 text-primary" />
              )}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuItem className="gap-2 text-xs" onClick={openCustomDialog}>
            <span className="min-w-0 flex-1 truncate">
              {setting.mode === "custom"
                ? `${t("chat.model_picker_custom")} · ${setting.model}`
                : t("chat.model_picker_custom")}
            </span>
            {setting.mode === "custom" && <Check className="size-3.5 shrink-0 text-primary" />}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent className="sm:max-w-sm gap-4">
          <DialogHeader>
            <DialogTitle className="text-sm">{t("chat.model_custom_title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="picker-custom-url" className="text-xs text-muted-foreground">
                {t("settings.model_base_url_label")}
              </Label>
              <Input
                id="picker-custom-url"
                placeholder="https://…"
                spellCheck={false}
                autoComplete="off"
                className="h-9 text-xs"
                value={customDraft.baseUrl}
                onChange={(e) => setCustomDraft((d) => ({ ...d, baseUrl: e.target.value }))}
              />
              <p className="text-2xs text-muted-foreground">{t("settings.model_base_url_hint")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="picker-custom-key" className="text-xs text-muted-foreground">
                {t("settings.model_api_key_label")}
              </Label>
              <Input
                id="picker-custom-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                className="h-9 text-xs"
                value={customDraft.apiKey}
                onChange={(e) => setCustomDraft((d) => ({ ...d, apiKey: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="picker-custom-model" className="text-xs text-muted-foreground">
                {t("settings.model_model_label")}
              </Label>
              <Input
                id="picker-custom-model"
                spellCheck={false}
                autoComplete="off"
                className="h-9 text-xs"
                value={customDraft.model}
                onChange={(e) => setCustomDraft((d) => ({ ...d, model: e.target.value }))}
              />
            </div>
            {customError && (
              <p className="text-2xs leading-relaxed text-destructive" role="alert">
                {customError}
              </p>
            )}
            <div className="flex justify-center gap-2 pt-1">
              <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setCustomOpen(false)}>
                {t("chat.model_custom_cancel")}
              </Button>
              <Button size="sm" className="h-8 text-xs" onClick={saveCustom}>
                {t("chat.model_custom_save")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
