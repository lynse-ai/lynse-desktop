"use client";

import { useEffect, useState } from "react";
import { api } from "@lynse/core/api";
import { useAuthStore } from "@lynse/core/auth";
import { useTranslation } from "@lynse/core/i18n/react";
import { CUSTOM_MODELS_CHANGED_EVENT, CUSTOM_MODELS_STORAGE_KEY } from "../custom-models";
import { featureFlags, isWikiEnabled } from "../feature-flags";
import { usePluginStore } from "../plugins/state";
import { getWorkbenchApi, useWorkbench } from "./api";
import { useMemoryDrafts } from "./memory-drafts";
import { useWikiBrowser } from "./wiki-browser-state";
import { resolveWorkbenchModelOverride, WORKBENCH_MODEL_CHANGED_EVENT, WORKBENCH_MODEL_STORAGE_KEY } from "./workbench-model";

/** Account lifecycle stays outside AuthGate so logout also cancels native work. */
export function WorkbenchSupervisor() {
  const authenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const hasMemoryDrafts = useMemoryDrafts((state) => Object.values(state.drafts).some((draft) => draft.markdown !== draft.original));
  useEffect(() => {
    if (!hasMemoryDrafts) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, [hasMemoryDrafts]);
  useEffect(() => { useMemoryDrafts.getState().clear(); useWikiBrowser.getState().setScope(undefined); }, [user?.id, authenticated]);
  const gmailPluginEnabled = usePluginStore((state) => !featureFlags.pluginMarketplace || !!state.entries["lynse.gmail"]?.enabled);
  const [configurationVersion, setConfigurationVersion] = useState(0);
  useEffect(() => {
    const changed = () => setConfigurationVersion((value) => value + 1);
    // Organization runs on the user's own custom model, decoupled from the
    // chat model: re-push the binding whenever it or its profile changes.
    const modelChanged = () => {
      if (!authenticated) return;
      const bridge = getWorkbenchApi();
      if (!bridge?.setTextModel) { changed(); return; }
      void bridge.setTextModel(resolveWorkbenchModelOverride()).catch((error: unknown) => {
        if (useWorkbench.getState().status) useWorkbench.getState().setError(String(error));
      });
    };
    const storageChanged = (event: StorageEvent) => {
      if (event.key === WORKBENCH_MODEL_STORAGE_KEY || event.key === CUSTOM_MODELS_STORAGE_KEY) modelChanged();
    };
    window.addEventListener(WORKBENCH_MODEL_CHANGED_EVENT, modelChanged);
    window.addEventListener(CUSTOM_MODELS_CHANGED_EVENT, modelChanged);
    window.addEventListener("storage", storageChanged);
    return () => {
      window.removeEventListener(WORKBENCH_MODEL_CHANGED_EVENT, modelChanged);
      window.removeEventListener(CUSTOM_MODELS_CHANGED_EVENT, modelChanged);
      window.removeEventListener("storage", storageChanged);
    };
  }, [authenticated]);
  const { i18n } = useTranslation();
  useEffect(() => {
    const bridge = getWorkbenchApi();
    if (!bridge) return;
    let disposed = false;
    let boundScope: string | undefined;
    let unlisten: (() => void) | undefined;
    useWorkbench.setState({ status: null, error: null, open: false, selectedId: null });
    const token = api().getToken();
    if (!authenticated || !token) { void bridge.unbind(); return; }
    void bridge.bind({ baseUrl: api().getBaseUrl(), agentUrl: api().getAgentBaseUrl() ?? undefined,
      token, locale: i18n.language, betaEnabled: isWikiEnabled(), gmailPluginEnabled, modelOverride: resolveWorkbenchModelOverride() })
      .then(async (status) => { if (!disposed) {
        boundScope = status?.scope; useWorkbench.getState().setStatus(status);
        await bridge.setTextModel?.(resolveWorkbenchModelOverride());
      } })
      .catch((error: unknown) => { if (!disposed) useWorkbench.getState().setError(String(error)); });
    void bridge.onUpdate((status) => {
      if (!disposed && boundScope === status.scope) useWorkbench.getState().setStatus(status);
    }).then((cleanup) => { if (disposed) cleanup(); else unlisten = cleanup; });
    const resume = () => {
      if (document.visibilityState !== "hidden" && useWorkbench.getState().status?.enabled) {
        void bridge.sync(false).catch((error: unknown) => useWorkbench.getState().setError(String(error)));
      }
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true; unlisten?.();
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
      void bridge.unbind();
    };
  }, [authenticated, user, i18n.language, configurationVersion, gmailPluginEnabled]);
  return null;
}

