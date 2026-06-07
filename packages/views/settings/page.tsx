"use client";

import { useState, useEffect } from "react";
import { PageHeader } from "../layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { useAuthStore } from "@lynse/core/auth";

const DEFAULT_API_URL = "http://119.97.160.133:10060";

export function SettingsPage() {
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
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Connection failed";
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
        <h1 className="text-sm font-semibold">Settings</h1>
      </PageHeader>

      <div className="flex-1 overflow-auto p-6">
        <div className="mx-auto max-w-2xl space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">API Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="api-url" className="text-xs">API Base URL</Label>
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
                <Label htmlFor="api-key" className="text-xs">API Key</Label>
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
                    Connected
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={handleDisconnect}
                  >
                    Disconnect
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleConnect}
                  disabled={!apiKey.trim() || connecting}
                >
                  {connecting ? "Connecting..." : "Connect"}
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
