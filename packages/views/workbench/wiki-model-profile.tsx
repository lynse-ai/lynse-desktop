"use client";

import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lynse/ui/components/ui/select";
import { Cpu } from "../icons";
import {
  CUSTOM_MODELS_CHANGED_EVENT,
  getCustomModelsApi,
  loadCustomModels,
  type CustomModelProfile,
} from "../custom-models";
import { getWorkbenchApi, useWorkbench } from "./api";
import {
  loadWorkbenchModelBinding,
  resolveWorkbenchModelOverride,
  saveWorkbenchModelBinding,
  WORKBENCH_MODEL_CHANGED_EVENT,
} from "./workbench-model";

const SettingsDialog = lazy(() => import("../settings/settings-dialog").then(module => ({ default: module.SettingsDialog })));

/**
 * Picks which custom model knowledge organization runs on. Organization
 * never uses the platform model: with nothing selected (or no vaulted key)
 * the desktop blocks the whole pass and surfaces a notice pointing here.
 */
export function WikiModelProfile({ disabled = false }: { disabled?: boolean }) {
  const { t } = useTranslation();
  const customModels = getCustomModelsApi();
  const [profiles, setProfiles] = useState<CustomModelProfile[]>([]);
  const [binding, setBinding] = useState<string | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(() => {
    setProfiles(loadCustomModels());
    setBinding(loadWorkbenchModelBinding());
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(CUSTOM_MODELS_CHANGED_EVENT, refresh);
    window.addEventListener(WORKBENCH_MODEL_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener(CUSTOM_MODELS_CHANGED_EVENT, refresh);
      window.removeEventListener(WORKBENCH_MODEL_CHANGED_EVENT, refresh);
    };
  }, [refresh]);

  const selected = profiles.find((profile) => profile.id === binding) ?? null;
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    let active = true;
    setHasKey(null);
    if (!selectedId || !customModels) return;
    void customModels.hasKey(selectedId)
      .then((value) => { if (active) setHasKey(value); })
      .catch(() => { if (active) setHasKey(false); });
    return () => { active = false; };
    // Re-check when the manager saves or clears a key.
  }, [selectedId, customModels, profiles]);

  if (!customModels) return null;

  async function choose(profileId: string | null) {
    setError("");
    saveWorkbenchModelBinding(profileId);
    setBinding(profileId);
    const bridge = getWorkbenchApi();
    if (!bridge?.setTextModel) return;
    try {
      await bridge.setTextModel(resolveWorkbenchModelOverride());
    } catch (cause) {
      if (useWorkbench.getState().status) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const notice = binding && !selected ? "workbench.organize_model_missing"
    : selected && hasKey === false ? "workbench.organize_model_no_key"
    : !profiles.length ? "workbench.organize_model_empty" : null;
  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t("workbench.organize_model_title")}>
    <div className="space-y-1.5">
      <h3 className="flex items-center gap-2 text-sm font-medium"><Cpu className="size-4 text-primary" aria-hidden="true" />{t("workbench.organize_model_title")}</h3>
      <p className="text-sm leading-relaxed text-muted-foreground">{t("workbench.organize_model_hint")}</p>
    </div>
    <Select
      value={selected?.id ?? ""}
      items={Object.fromEntries(profiles.map((profile) => [profile.id, `${profile.label} · ${profile.model}`]))}
      onValueChange={(value) => void choose(value || null)}
      disabled={disabled || !profiles.length}
    >
      <SelectTrigger className="h-9 text-sm" aria-label={t("workbench.organize_model_title")}>
        <SelectValue placeholder={t("workbench.organize_model_none")} />
      </SelectTrigger>
      <SelectContent>
        {profiles.map((profile) => (
          <SelectItem key={profile.id} value={profile.id}>{profile.label} · {profile.model}</SelectItem>
        ))}
      </SelectContent>
    </Select>
    {notice && <p role="status" className={`text-sm ${notice === "workbench.organize_model_empty" ? "text-muted-foreground" : "text-destructive"}`}>{t(notice)}</p>}
    {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
    <Button type="button" size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>{t("workbench.organize_model_manage")}</Button>
    {settingsOpen && <Suspense fallback={null}><SettingsDialog open onOpenChange={setSettingsOpen} initialSectionId="custom_models" /></Suspense>}
  </section>;
}
