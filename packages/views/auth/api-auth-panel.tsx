"use client";

import { useEffect, useState } from "react";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lynse/ui/components/ui/select";
import { api } from "@lynse/core/api";
import { useAuthStore } from "@lynse/core/auth";
import {
  AGENT_API_URL_STORAGE_KEY,
  agentUrlForApiUrl,
  DEFAULT_API_URL,
  TEST_API_URL,
} from "@lynse/core/config";
import { useTranslation } from "@lynse/core/i18n/react";
import { Loader2 } from "../icons";
import { authErrorText } from "./auth-errors";

/**
 * Backends testers can pick between. Production is the default selection so
 * an untouched config always points at the released backend — the same
 * default the API client itself falls back to (core/config).
 */
const SERVER_PRESETS = [
  { url: TEST_API_URL, labelKey: "auth.api_config_server_test" },
  { url: DEFAULT_API_URL, labelKey: "auth.api_config_server_prod" },
] as const;

const DEFAULT_SERVER_URL = DEFAULT_API_URL;

// Shared pill-input treatment (borderless muted fill, sized to match the
// compact login form).
const pillInputClass =
  "h-9 rounded-full border-0 bg-muted px-3.5 text-sm shadow-none focus-visible:ring-0 focus-visible:shadow-none";

/**
 * Server selection + API-key sign-in in one form — API configuration and the
 * API login are the same thing, so this panel is the single UI for both. It
 * mounts inside the login page (API view / github build's main form) and on
 * the standalone /api-config page. `onSuccess` runs after a successful
 * connect; the standalone page uses it to leave, while inside the login flow
 * the auth gate swaps screens on its own.
 */
export function ApiAuthPanel({ onSuccess }: { onSuccess?: () => void }) {
  const { t } = useTranslation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);

  const [selectedUrl, setSelectedUrl] = useState<string>(DEFAULT_SERVER_URL);
  const [appliedUrl, setAppliedUrl] = useState<string>("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const savedUrl = localStorage.getItem("lynse_api_url");
    if (savedUrl) {
      setAppliedUrl(savedUrl);
      // A legacy hand-typed URL has no preset to show — fall back to production.
      setSelectedUrl(
        SERVER_PRESETS.some((p) => p.url === savedUrl)
          ? savedUrl
          : DEFAULT_SERVER_URL,
      );
    }
    const savedKey = localStorage.getItem("lynse_api_key");
    if (savedKey) setApiKey(savedKey);
  }, []);

  function serverLabel(url: string): string {
    const preset = SERVER_PRESETS.find((p) => p.url === url);
    return preset ? t(preset.labelKey) : url;
  }

  /** Apply the selected server to this session (client + persistence). The
   *  assistant moves with it: file ids are per-environment, so a server
   *  switch must drop any agent override that points somewhere else. */
  function applyServer(url: string) {
    api().setBaseUrl(url);
    localStorage.setItem("lynse_api_url", url);
    const agentUrl = agentUrlForApiUrl(url);
    api().setAgentBaseUrl(agentUrl);
    if (agentUrl) localStorage.setItem(AGENT_API_URL_STORAGE_KEY, agentUrl);
    else localStorage.removeItem(AGENT_API_URL_STORAGE_KEY);
    setAppliedUrl(url);
  }

  /**
   * The confirm button: point this session at the selected server. Switching
   * while signed in drops the session first — its token belongs to the
   * previous server.
   */
  function handleConfirmServer() {
    if (isAuthenticated && selectedUrl !== appliedUrl) logout();
    applyServer(selectedUrl);
  }

  async function handleConnect() {
    if (!apiKey.trim()) return;
    setError(null);
    setConnecting(true);
    // Connecting always targets the currently selected server, confirmed
    // through the button above or not.
    applyServer(selectedUrl);
    try {
      await login(apiKey.trim(), selectedUrl);
      onSuccess?.();
    } catch (e: unknown) {
      setError(authErrorText(e, t));
    } finally {
      setConnecting(false);
    }
  }

  function handleDisconnect() {
    logout();
    setApiKey("");
  }

  const serverItems = Object.fromEntries(
    SERVER_PRESETS.map((p) => [p.url, t(p.labelKey)]),
  );

  return (
    <div className="space-y-3.5">
      <div className="space-y-1.5">
        <Label htmlFor="api-config-url" className="text-xs text-muted-foreground">
          {t("auth.api_config_base_url")}
        </Label>
        <div className="flex items-center gap-2">
          <Select
            items={serverItems}
            value={selectedUrl}
            onValueChange={(value) => setSelectedUrl(String(value))}
          >
            <SelectTrigger
              id="api-config-url"
              className={`flex-1 ${pillInputClass}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SERVER_PRESETS.map((preset) => (
                <SelectItem key={preset.url} value={preset.url}>
                  {t(preset.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            className="h-9 shrink-0 rounded-full px-4 text-xs"
            onClick={handleConfirmServer}
          >
            {t("auth.api_config_confirm")}
          </Button>
        </div>
        {appliedUrl && (
          <p className="text-2xs leading-relaxed text-muted-foreground">
            {t("auth.api_config_applied", {
              server: serverLabel(appliedUrl),
              url: appliedUrl,
            })}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="api-config-key" className="text-xs text-muted-foreground">
          {t("auth.api_config_key")}
        </Label>
        <Input
          id="api-config-key"
          type="password"
          placeholder="dk-..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleConnect();
          }}
          className={pillInputClass}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {isAuthenticated ? (
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 text-xs text-success">
            <span className="size-1.5 rounded-full bg-success" />
            {t("auth.api_config_connected")}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-8 rounded-full text-xs"
            onClick={handleDisconnect}
          >
            {t("auth.api_config_disconnect")}
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          className="h-9 w-full rounded-full text-sm font-medium"
          onClick={handleConnect}
          disabled={!apiKey.trim() || connecting}
        >
          {connecting ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {t("auth.api_key_connecting")}
            </>
          ) : (
            t("auth.api_key_connect")
          )}
        </Button>
      )}
    </div>
  );
}
