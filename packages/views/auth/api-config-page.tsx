"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
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
import { useNavigation } from "../navigation";
import { useTranslation } from "@lynse/core/i18n/react";
import { authErrorText } from "./auth-errors";

/**
 * Backends testers can pick between on this page. Production is the default
 * selection so an untouched config always points at the released backend.
 */
const SERVER_PRESETS = [
  { url: "http://119.97.160.133:10060", labelKey: "auth.api_config_server_test" },
  { url: "https://api.lynse.cn", labelKey: "auth.api_config_server_prod" },
] as const;

const DEFAULT_SERVER_URL = SERVER_PRESETS[1].url;

/**
 * Standalone API configuration page, linked from the login page's bottom-left
 * corner. The backend URL is chosen from the preset server list above and
 * applied for the current session via the confirm button (persisted as
 * `lynse_api_url`); the API-key field below then connects against it.
 */
export function ApiConfigPage() {
  const { t } = useTranslation();
  const { push } = useNavigation();
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

  /** Apply the selected server to this session (client + persistence). */
  function applyServer(url: string) {
    api().setBaseUrl(url);
    localStorage.setItem("lynse_api_url", url);
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
      push("/");
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
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-3">
        <button
          type="button"
          onClick={() => push("/")}
          className="text-2xs text-muted-foreground transition-colors hover:text-foreground"
        >
          ← {t("auth.api_config_back")}
        </button>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs">{t("auth.api_config_title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-2xs leading-relaxed text-muted-foreground">
              {t("auth.api_config_hint")}
            </p>

            <div className="space-y-1.5">
              <Label htmlFor="api-config-url" className="text-xs">
                {t("auth.api_config_base_url")}
              </Label>
              <div className="flex items-center gap-2">
                <Select
                  items={serverItems}
                  value={selectedUrl}
                  onValueChange={(value) => setSelectedUrl(String(value))}
                >
                  <SelectTrigger id="api-config-url" className="h-8 flex-1 text-sm">
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
                  className="h-8 shrink-0 text-xs"
                  onClick={handleConfirmServer}
                >
                  {t("auth.api_config_confirm")}
                </Button>
              </div>
              {appliedUrl && (
                <p className="text-2xs text-muted-foreground">
                  {t("auth.api_config_applied", {
                    server: serverLabel(appliedUrl),
                    url: appliedUrl,
                  })}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="api-config-key" className="text-xs">
                {t("auth.api_config_key")}
              </Label>
              <Input
                id="api-config-key"
                type="password"
                placeholder="dk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="h-8 text-sm"
              />
            </div>

            {error && <p className="text-xs text-destructive">{error}</p>}

            {isAuthenticated ? (
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-1.5 text-xs text-success">
                  <span className="size-1.5 rounded-full bg-success" />
                  {t("auth.api_config_connected")}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={handleDisconnect}
                >
                  {t("auth.api_config_disconnect")}
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={handleConnect}
                disabled={!apiKey.trim() || connecting}
              >
                {connecting ? t("auth.api_key_connecting") : t("auth.api_key_connect")}
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
