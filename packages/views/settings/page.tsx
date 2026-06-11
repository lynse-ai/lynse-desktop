"use client";

import { useState, useEffect } from "react";
import { PageHeader } from "../layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { useAuthStore } from "@lynse/core/auth";
import { useTheme } from "@lynse/ui/components/common/theme-provider";
import { useTranslation } from "@lynse/core/i18n/react";
import { Sun, Moon, Monitor } from "../icons";
import { cn } from "@lynse/ui/lib/utils";

const DEFAULT_API_URL = "http://119.97.160.133:10060";

type ThemeOption = "light" | "dark" | "system";

export function SettingsPage() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();

  const themeOptions: { value: ThemeOption; label: string; icon: typeof Sun }[] = [
    { value: "light", label: t("layout.theme_light"), icon: Sun },
    { value: "dark", label: t("layout.theme_dark"), icon: Moon },
    { value: "system", label: t("layout.theme_system"), icon: Monitor },
  ];

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
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : t("settings.connection_failed");
      setError(message);
    } finally {
      setConnecting(false);
    }
  }

  function handleDisconnect() {
    logout();
    setApiKey("");
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader>
        <h1 className="text-sm font-semibold">{t("nav.settings")}</h1>
      </PageHeader>

      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-2xl space-y-6">
          {/* ── Appearance ─────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t("settings.appearance")}</CardTitle>
            </CardHeader>
            <CardContent>
              <Label className="text-xs mb-3 block">{t("layout.theme")}</Label>
              <div className="grid grid-cols-3 gap-2">
                {themeOptions.map((option) => {
                  const isActive = theme === option.value;
                  const Icon = option.icon;
                  return (
                    <button
                      key={option.value}
                      onClick={() => setTheme(option.value)}
                      className={cn(
                        "flex flex-col items-center gap-2 rounded-lg border-2 px-3 py-3 text-xs font-medium transition-all",
                        isActive
                          ? "border-primary bg-primary/5 text-foreground"
                          : "border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
                      )}
                    >
                      <Icon className="size-5" />
                      <span>{option.label}</span>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* ── API Configuration ──────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t("settings.api_config")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="api-url" className="text-xs">{t("settings.api_base_url")}</Label>
                <Input
                  id="api-url"
                  placeholder={DEFAULT_API_URL}
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                  className="h-8 text-sm"
                  disabled={isAuthenticated}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="api-key" className="text-xs">{t("settings.api_key")}</Label>
                <Input
                  id="api-key"
                  type="password"
                  placeholder="dk-..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="h-8 text-sm"
                  disabled={isAuthenticated}
                />
              </div>

              {error && (
                <p className="text-xs text-destructive">{error}</p>
              )}

              {isAuthenticated ? (
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center gap-1.5 text-xs text-green-600">
                    <span className="size-1.5 rounded-full bg-green-500" />
                    {t("settings.connected")}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={handleDisconnect}
                  >
                    {t("settings.disconnect")}
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleConnect}
                  disabled={!apiKey.trim() || connecting}
                >
                  {connecting ? t("settings.connecting") : t("settings.connect")}
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
