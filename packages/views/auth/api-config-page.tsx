"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { useAuthStore } from "@lynse/core/auth";
import { useNavigation } from "../navigation";
import { useTranslation } from "@lynse/core/i18n/react";

export const DEFAULT_API_URL = "https://api.lynse.cn";

/**
 * Standalone API configuration page, linked from the login page's bottom-left
 * corner. Replaces the API configuration card that used to live in the
 * settings dialog: backend URL + API-key connect.
 */
export function ApiConfigPage() {
  const { t } = useTranslation();
  const { push } = useNavigation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);

  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    const savedUrl = localStorage.getItem("lynse_api_url");
    if (savedUrl) setApiUrl(savedUrl);
    const savedKey = localStorage.getItem("lynse_api_key");
    if (savedKey) setApiKey(savedKey);
  }, []);

  async function handleConnect() {
    if (!apiKey.trim()) return;
    setError(null);
    setConnecting(true);
    try {
      await login(apiKey.trim(), apiUrl.trim());
      push("/");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("auth.api_key_connect_failed"));
    } finally {
      setConnecting(false);
    }
  }

  function handleDisconnect() {
    logout();
    setApiKey("");
  }

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
              <Input
                id="api-config-url"
                placeholder={DEFAULT_API_URL}
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                className="h-8 text-sm"
                disabled={isAuthenticated}
              />
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
                disabled={isAuthenticated}
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
