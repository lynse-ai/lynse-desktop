"use client";

import { useCallback, useEffect, useState } from "react";
import { create } from "zustand";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Label } from "@lynse/ui/components/ui/label";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { Cpu, Loader2, Plus, Trash2 } from "../icons";
import { isHttpUrl } from "../workspace/model-override";
import {
  CUSTOM_MODELS_CHANGED_EVENT,
  getCustomModel,
  isValidProfileId,
  loadCustomModels,
  removeCustomModel,
  suggestProfileId,
  toCompletionBase,
  upsertCustomModel,
} from "./models";
import { getCustomModelsApi, type CustomModelProfile } from "./types";
import { customModelConnectionErrorKey } from "./connection-errors";

type EditorState = {
  id: string | null;
  label: string;
  baseUrl: string;
  model: string;
  apiKey: string;
};

const emptyEditor = (): EditorState => ({
  id: null,
  label: "",
  baseUrl: "",
  model: "",
  apiKey: "",
});

type ConnectionTest =
  | { status: "pending" | "passed" }
  | { status: "failed"; error: ReturnType<typeof customModelConnectionErrorKey> };

const useConnectionTests = create<{ tests: Record<string, ConnectionTest | undefined> }>(() => ({ tests: {} }));

function setConnectionTest(id: string, test: ConnectionTest | undefined) {
  useConnectionTests.setState(({ tests }) => {
    const next = { ...tests };
    if (test) next[id] = test;
    else delete next[id];
    return { tests: next };
  });
}

/**
 * Management surface for custom models: shared BYO endpoints that features
 * (knowledge organization, local recording summaries, …) select from. Keys
 * are write-only here — the bridge stores them in the system keychain and
 * nothing reads them back to the UI.
 */
export function CustomModelsCard() {
  const { t } = useTranslation();
  const bridge = getCustomModelsApi();
  const [profiles, setProfiles] = useState<CustomModelProfile[]>([]);
  const [keyStates, setKeyStates] = useState<Record<string, boolean | "unavailable">>({});
  const tests = useConnectionTests((state) => state.tests);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    setProfiles(loadCustomModels());
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(CUSTOM_MODELS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CUSTOM_MODELS_CHANGED_EVENT, refresh);
  }, [refresh]);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    for (const { id } of profiles) {
      void bridge.hasKey(id).catch(() => "unavailable" as const).then((hasKey) => {
        if (active) setKeyStates((states) => ({ ...states, [id]: hasKey }));
      });
    }
    return () => { active = false; };
  }, [bridge, profiles]);

  if (!bridge) return null;

  function startAdd() {
    setError(null);
    setEditor({ ...emptyEditor(), id: suggestProfileId(t("customModels.label_placeholder")) });
  }

  function startEdit(profile: CustomModelProfile) {
    setError(null);
    setEditor({
      id: profile.id,
      label: profile.label,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: "",
    });
  }

  async function testConnection(profile: CustomModelProfile) {
    if (!bridge || useConnectionTests.getState().tests[profile.id]?.status === "pending") return;
    setConnectionTest(profile.id, { status: "pending" });
    try {
      await bridge.testConnection(toCompletionBase(profile));
      setConnectionTest(profile.id, { status: "passed" });
    } catch (cause) {
      setConnectionTest(profile.id, { status: "failed", error: customModelConnectionErrorKey(cause) });
    }
  }

  async function save() {
    if (!bridge || !editor || busy) return;
    const label = editor.label.trim();
    const baseUrl = editor.baseUrl.trim().replace(/\/+$/, "");
    const model = editor.model.trim();
    if (!label) { setError(t("customModels.invalid_label")); return; }
    if (!isHttpUrl(baseUrl)) { setError(t("settings.model_invalid_url")); return; }
    if (!model) { setError(t("customModels.connection_invalid_model")); return; }
    const id = editor.id && isValidProfileId(editor.id) ? editor.id : suggestProfileId(label);
    setBusy(true); setError(null);
    try {
      const key = editor.apiKey.trim();
      // Write the key first so a failed keychain write doesn't leave a
      // half-configured profile behind.
      if (key) await bridge.setKey(id, key);
      const profile: CustomModelProfile = {
        id,
        label,
        baseUrl,
        model,
        createdAt: getCustomModel(id)?.createdAt ?? new Date().toISOString(),
      };
      upsertCustomModel(profile);
      setEditor(null);
      void testConnection(profile);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function clearKey(profileId: string) {
    if (!bridge || busy) return;
    setBusy(true);
    try {
      await bridge.setKey(profileId, null);
      setKeyStates((states) => ({ ...states, [profileId]: false }));
      setConnectionTest(profileId, undefined);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(profile: CustomModelProfile) {
    if (!bridge || busy) return;
    setBusy(true);
    removeCustomModel(profile.id);
    setConnectionTest(profile.id, undefined);
    // Best effort: drop the vaulted key too so stale secrets don't linger.
    await bridge.setKey(profile.id, null).catch(() => undefined);
    setBusy(false);
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-xs">
          <Cpu className="size-3.5" />
          {t("customModels.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-2xs leading-relaxed text-muted-foreground">{t("customModels.hint")}</p>

        {profiles.length === 0 && !editor && (
          <p className="text-2xs leading-relaxed text-muted-foreground">{t("customModels.empty")}</p>
        )}

        {profiles.map((profile) => {
          const test = tests[profile.id];
          const testing = test?.status === "pending";
          const keyState = keyStates[profile.id];
          const failure = test?.status === "failed" ? test.error
            : keyState === false ? "customModels.key_missing"
            : keyState === "unavailable" ? "customModels.key_read_failed" : null;
          const status = testing ? "customModels.connection_testing"
            : failure ?? (test?.status === "passed" ? "customModels.connection_passed"
              : keyState ? "customModels.connection_untested" : "customModels.key_checking");
          const editing = editor?.id === profile.id;
          return (
            <div key={profile.id} className="space-y-1 rounded-md border border-border px-2.5 py-2">
              <div className="flex flex-wrap items-center justify-between gap-x-2">
                <div className="min-w-0">
                  <p className="break-words text-xs font-medium">{profile.label}</p>
                  <p className="break-all text-2xs text-muted-foreground">{profile.model}</p>
                </div>
                <div className="flex items-center gap-1">
                  <Button type="button" size="sm" variant="outline" disabled={busy || testing || editing} onClick={() => void testConnection(profile)}>
                    {testing && <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                    {t("customModels.connection_test")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" disabled={busy || testing || editing} onClick={() => startEdit(profile)}>{t("customModels.edit")}</Button>
                  <Button type="button" size="sm" variant="ghost" disabled={busy || testing || editing} aria-label={t("customModels.delete")} onClick={() => void remove(profile)}>
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
              </div>
              <p role={failure && !testing ? "alert" : "status"} className={cn("text-2xs leading-relaxed", failure && !testing ? "text-destructive" : "text-muted-foreground")}>
                {t(status)}
              </p>
            </div>
          );
        })}

        {editor && (
          <div className="space-y-2.5 rounded-md border border-border p-2.5">
            <div className="space-y-1.5">
              <Label htmlFor="custom-model-label" className="text-xs text-muted-foreground">{t("customModels.label_label")}</Label>
              <Input
                id="custom-model-label"
                className="h-9 text-xs"
                placeholder={t("customModels.label_placeholder")}
                value={editor.label}
                onChange={(event) => setEditor((current) => current && { ...current, label: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="custom-model-model" className="text-xs text-muted-foreground">{t("settings.model_model_label")}</Label>
              <Input
                id="custom-model-model"
                className="h-9 text-xs"
                spellCheck={false}
                autoComplete="off"
                value={editor.model}
                onChange={(event) => setEditor((current) => current && { ...current, model: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="custom-model-url" className="text-xs text-muted-foreground">{t("settings.model_base_url_label")}</Label>
              <Input
                id="custom-model-url"
                className="h-9 text-xs"
                placeholder="https://…"
                spellCheck={false}
                autoComplete="off"
                value={editor.baseUrl}
                onChange={(event) => setEditor((current) => current && { ...current, baseUrl: event.target.value })}
              />
              <p className="text-2xs text-muted-foreground">{t("settings.model_base_url_hint")}</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="custom-model-key" className="text-xs text-muted-foreground">{t("settings.model_api_key_label")}</Label>
              <Input
                id="custom-model-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                className="h-9 text-xs"
                value={editor.apiKey}
                placeholder={editor.id && keyStates[editor.id] === true ? t("customModels.key_saved") : undefined}
                onChange={(event) => setEditor((current) => current && { ...current, apiKey: event.target.value })}
              />
              <p className="text-2xs text-muted-foreground">{t("customModels.key_input_hint")}</p>
              {editor.id && keyStates[editor.id] === true && (
                <Button type="button" size="sm" variant="ghost" className="h-7 text-2xs" disabled={busy} onClick={() => void clearKey(editor.id!)}>
                  {t("customModels.key_clear")}
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>{t("customModels.save_and_test")}</Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditor(null)}>{t("workbench.cancel")}</Button>
            </div>
          </div>
        )}

        {!editor && (
          <Button type="button" size="sm" variant="outline" onClick={startAdd}>
            <Plus className="size-3.5" aria-hidden="true" />
            {t("customModels.add")}
          </Button>
        )}

        {error && <p className="text-2xs leading-relaxed text-destructive" role="alert">{error}</p>}
      </CardContent>
    </Card>
  );
}
