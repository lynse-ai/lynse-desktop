"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lynse/ui/components/ui/select";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  fetchModelPresets,
  flattenPresetModels,
  isHttpUrl,
  loadChatModelSetting,
  saveChatModelSetting,
  type ChatModelSetting,
  type ModelPreset,
} from "../workspace/model-override";
import { Cpu } from "../icons";
import { BetaBadge } from "../beta-badge";

type ModelMode = ChatModelSetting["mode"];

/**
 * Model picker for the lynclaw chat turns (per-request `modelOverride`).
 * "default" sends no override; "preset" picks a served model directly by name
 * (the serving preset stays hidden plumbing); "custom" points at any
 * OpenAI-compatible endpoint. Changes persist locally and land on the next
 * sent message — nothing is written server-side.
 */
export function ModelConfigCard() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ModelMode>("default");
  const [presetId, setPresetId] = useState("");
  const [presetModel, setPresetModel] = useState("");
  const [presetApiKey, setPresetApiKey] = useState("");
  const [custom, setCustom] = useState({ baseUrl: "", apiKey: "", model: "" });
  const [presets, setPresets] = useState<ModelPreset[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modeRef = useRef<ModelMode>(mode);
  const presetModelRef = useRef(presetModel);
  modeRef.current = mode;
  presetModelRef.current = presetModel;

  useEffect(() => {
    const stored = loadChatModelSetting();
    setMode(stored.mode);
    if (stored.mode === "preset") {
      setPresetId(stored.presetId);
      setPresetModel(stored.model);
      setPresetApiKey(stored.apiKey ?? "");
    } else if (stored.mode === "custom") {
      setCustom({ baseUrl: stored.baseUrl, apiKey: stored.apiKey, model: stored.model });
    }
  }, []);

  useEffect(() => {
    let active = true;
    setLoadFailed(false);
    fetchModelPresets()
      .then((list) => {
        if (!active) return;
        setPresets(list);
        const flattened = flattenPresetModels(list);
        // Judge against the persisted setting, not component state — the user
        // may have changed things while the request was in flight. A preset
        // that vanished server-side falls back to the default model rather
        // than failing every future turn with a 400 "未知模型预设".
        const stored = loadChatModelSetting();
        if (stored.mode === "preset" && !list.some((p) => p.id === stored.presetId)) {
          setMode("default");
          setPresetId("");
          setPresetModel("");
          saveChatModelSetting({ mode: "default" });
          return;
        }
        // If the user switched to built-in mode while presets were still
        // loading, bind the first available model now.
        if (modeRef.current === "preset" && !presetModelRef.current && flattened[0]) {
          const first = flattened[0];
          setPresetId(first.preset.id);
          setPresetModel(first.model);
          setPresetApiKey("");
          if (first.preset.requiresApiKey) {
            setError(t("settings.model_preset_key_required"));
          } else {
            saveChatModelSetting({ mode: "preset", presetId: first.preset.id, model: first.model });
          }
        }
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [t]);

  const servedModels = flattenPresetModels(presets ?? []);
  const selectedEntry =
    servedModels.find((entry) => entry.model === presetModel && (!presetId || entry.preset.id === presetId)) ??
    servedModels.find((entry) => entry.model === presetModel) ??
    null;

  function applyPresetModel(entry: { model: string; preset: ModelPreset }, apiKey: string) {
    setPresetId(entry.preset.id);
    setPresetModel(entry.model);
    const trimmedKey = apiKey.trim();
    if (entry.preset.requiresApiKey && !trimmedKey) {
      setError(t("settings.model_preset_key_required"));
      return;
    }
    setError(null);
    saveChatModelSetting({
      mode: "preset",
      presetId: entry.preset.id,
      model: entry.model,
      ...(trimmedKey ? { apiKey: trimmedKey } : {}),
    });
  }

  function switchMode(next: ModelMode) {
    setMode(next);
    setError(null);
    if (next === "default") {
      saveChatModelSetting({ mode: "default" });
      return;
    }
    if (next === "preset") {
      const target = selectedEntry ?? servedModels[0] ?? null;
      if (target) {
        setPresetApiKey("");
        applyPresetModel(target, "");
      }
      // No list yet (still loading / failed): keep the draft local; the
      // model select below surfaces the state and nothing is persisted
      // until a model is actually resolved.
      return;
    }
    // "custom": keep whatever is typed; persistence happens per keystroke
    // once the three fields validate (see updateCustom).
  }

  function choosePresetModel(model: string | null) {
    const entry = servedModels.find((item) => item.model === model);
    if (!entry) return;
    setPresetApiKey("");
    applyPresetModel(entry, "");
  }

  function updatePresetApiKey(value: string) {
    setPresetApiKey(value);
    if (!selectedEntry) return;
    applyPresetModel(selectedEntry, value);
  }

  function updateCustom(patch: Partial<typeof custom>) {
    const next = { ...custom, ...patch };
    setCustom(next);
    const { baseUrl, apiKey, model } = next;
    if (!baseUrl.trim() && !apiKey.trim() && !model.trim()) {
      // Fully cleared: stop overriding instead of nagging about validation.
      setError(null);
      setMode("default");
      saveChatModelSetting({ mode: "default" });
      return;
    }
    if (!isHttpUrl(baseUrl.trim())) {
      setError(t("settings.model_invalid_url"));
      return;
    }
    if (!baseUrl.trim() || !apiKey.trim() || !model.trim()) {
      setError(t("settings.model_invalid_custom"));
      return;
    }
    setError(null);
    saveChatModelSetting({ mode: "custom", baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() });
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-xs">
          <Cpu className="size-3.5" />
          {t("settings.model_title")}
          <BetaBadge />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-2xs leading-relaxed text-muted-foreground">{t("settings.model_hint")}</p>

        <div className="space-y-1.5">
          <Label htmlFor="model-mode" className="text-xs text-muted-foreground">
            {t("settings.model_mode_label")}
          </Label>
          <Select
            value={mode}
            items={{
              default: t("settings.model_mode_default"),
              preset: t("settings.model_mode_preset"),
              custom: t("settings.model_mode_custom"),
            }}
            onValueChange={(value) => switchMode(value as ModelMode)}
          >
            <SelectTrigger id="model-mode" className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{t("settings.model_mode_default")}</SelectItem>
              <SelectItem value="preset">{t("settings.model_mode_preset")}</SelectItem>
              <SelectItem value="custom">{t("settings.model_mode_custom")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {mode === "preset" && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="model-preset-model" className="text-xs text-muted-foreground">
                {t("settings.model_model_label")}
              </Label>
              <Select
                value={presetModel}
                onValueChange={choosePresetModel}
                disabled={!presets || servedModels.length === 0}
              >
                <SelectTrigger id="model-preset-model" className="h-9 text-xs">
                  <SelectValue placeholder={presets ? t("settings.model_model_label") : t("settings.model_presets_loading")} />
                </SelectTrigger>
                <SelectContent>
                  {servedModels.map(({ model }) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {loadFailed && (
                <p className="text-2xs leading-relaxed text-destructive" role="alert">
                  {t("settings.model_presets_failed")}
                </p>
              )}
            </div>

            {selectedEntry?.preset.requiresApiKey && (
              <div className="space-y-1.5">
                <Label htmlFor="model-preset-key" className="text-xs text-muted-foreground">
                  {t("settings.model_api_key_label")}
                </Label>
                <Input
                  id="model-preset-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-9 text-xs"
                  value={presetApiKey}
                  onChange={(e) => updatePresetApiKey(e.target.value)}
                />
                <p className="text-2xs text-muted-foreground">{t("settings.model_api_key_hint")}</p>
              </div>
            )}
          </>
        )}

        {mode === "custom" && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="model-custom-url" className="text-xs text-muted-foreground">
                {t("settings.model_base_url_label")}
              </Label>
              <Input
                id="model-custom-url"
                placeholder="https://…"
                spellCheck={false}
                autoComplete="off"
                className="h-9 text-xs"
                value={custom.baseUrl}
                onChange={(e) => updateCustom({ baseUrl: e.target.value })}
              />
              <p className="text-2xs text-muted-foreground">{t("settings.model_base_url_hint")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="model-custom-key" className="text-xs text-muted-foreground">
                {t("settings.model_api_key_label")}
              </Label>
              <Input
                id="model-custom-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                className="h-9 text-xs"
                value={custom.apiKey}
                onChange={(e) => updateCustom({ apiKey: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="model-custom-model" className="text-xs text-muted-foreground">
                {t("settings.model_model_label")}
              </Label>
              <Input
                id="model-custom-model"
                spellCheck={false}
                autoComplete="off"
                className="h-9 text-xs"
                value={custom.model}
                onChange={(e) => updateCustom({ model: e.target.value })}
              />
            </div>
          </>
        )}

        {error && (
          <p className="text-2xs leading-relaxed text-destructive" role="alert">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
