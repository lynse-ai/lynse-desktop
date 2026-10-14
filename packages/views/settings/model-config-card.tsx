"use client";

import { useEffect, useState } from "react";
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
  isHttpUrl,
  loadChatModelSetting,
  saveChatModelSetting,
  type ChatModelSetting,
  type ModelPreset,
} from "../workspace/model-override";
import { Cpu } from "../icons";

type ModelMode = ChatModelSetting["mode"];

/**
 * Model picker for the lynclaw chat turns (per-request `modelOverride`).
 * "default" sends no override; "preset" picks from the served preset list;
 * "custom" points at any OpenAI-compatible endpoint. Changes persist locally
 * and land on the next sent message — nothing is written server-side.
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
        // Judge against the persisted setting, not component state — the user
        // may have changed things while the request was in flight. A preset
        // that vanished server-side falls back to the default model rather
        // than failing every future turn with a 400 "未知模型预设".
        const stored = loadChatModelSetting();
        if (stored.mode === "preset" && !list.some((p) => p.id === stored.presetId)) {
          setMode("default");
          saveChatModelSetting({ mode: "default" });
        }
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const preset = presets?.find((p) => p.id === presetId) ?? null;

  function switchMode(next: ModelMode) {
    setMode(next);
    setError(null);
    if (next === "default") {
      saveChatModelSetting({ mode: "default" });
      return;
    }
    if (next === "preset") {
      const target = preset ?? presets?.[0] ?? null;
      if (target) {
        setPresetId(target.id);
        setPresetModel(target.defaultModel);
        setPresetApiKey("");
        saveChatModelSetting({ mode: "preset", presetId: target.id, model: target.defaultModel });
      }
      // No list yet (still loading / failed): keep the draft local; the
      // preset select below surfaces the state and nothing is persisted
      // until a preset is actually chosen.
      return;
    }
    // "custom": keep whatever is typed; persistence happens per keystroke
    // once the three fields validate (see updateCustom).
  }

  function choosePreset(id: string | null) {
    const target = presets?.find((p) => p.id === id);
    if (!target) return;
    setPresetId(id!);
    setPresetModel(target.defaultModel);
    setPresetApiKey("");
    setError(null);
    saveChatModelSetting({ mode: "preset", presetId: id!, model: target.defaultModel });
  }

  function choosePresetModel(model: string | null) {
    if (!model || !preset) return;
    setPresetModel(model);
    setError(null);
    saveChatModelSetting({ mode: "preset", presetId: preset.id, model, apiKey: presetApiKey || undefined });
  }

  function updatePresetApiKey(value: string) {
    setPresetApiKey(value);
    setError(null);
    if (!preset) return;
    // requiresApiKey presets have no server credential — an empty key would
    // 400 every turn, so hold persistence until one is filled in.
    if (preset.requiresApiKey && !value.trim()) {
      setError(t("settings.model_preset_key_required"));
      return;
    }
    saveChatModelSetting({
      mode: "preset",
      presetId: preset.id,
      model: presetModel,
      apiKey: value.trim() || undefined,
    });
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
              <Label htmlFor="model-preset" className="text-xs text-muted-foreground">
                {t("settings.model_preset_label")}
              </Label>
              <Select
                value={presetId}
                items={Object.fromEntries((presets ?? []).map((p) => [p.id, p.label]))}
                onValueChange={choosePreset}
                disabled={!presets}
              >
                <SelectTrigger id="model-preset" className="h-9 text-xs">
                  <SelectValue placeholder={presets ? t("settings.model_preset_label") : t("settings.model_presets_loading")} />
                </SelectTrigger>
                <SelectContent>
                  {(presets ?? []).map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {loadFailed && (
                <p className="text-2xs leading-relaxed text-destructive" role="alert">
                  {t("settings.model_presets_failed")}
                </p>
              )}
              {preset?.note && <p className="text-2xs text-muted-foreground">{preset.note}</p>}
            </div>

            {preset && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="model-preset-model" className="text-xs text-muted-foreground">
                    {t("settings.model_model_label")}
                  </Label>
                  <Select value={presetModel} onValueChange={choosePresetModel}>
                    <SelectTrigger id="model-preset-model" className="h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {preset.models.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {preset.requiresApiKey && (
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
