"use client";

import { useEffect, useState } from "react";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@lynse/ui/components/ui/dropdown-menu";
import { api } from "@lynse/core/api";
import { useAuthStore } from "@lynse/core/auth";
import {
  AGENT_API_URL_STORAGE_KEY,
  agentUrlForApiUrl,
  DEFAULT_API_URL,
  TEST_API_URL,
  defaultApiUrlForEdition,
  type LynseEdition,
} from "@lynse/core/config";
import { useTranslation } from "@lynse/core/i18n/react";
import { Check, ChevronDown, Loader2 } from "../icons";
import { RegionFlag } from "./flags";
import { authErrorText } from "./auth-errors";

type ServerEntry = { url: string; labelKey: string; edition: LynseEdition };

/**
 * Backends testers can pick between, one entry per gateway. The login site
 * (edition) is folded into the same list — every gateway belongs to exactly
 * one account system — so picking a server also decides the sign-in methods
 * through `onRegionChange` (user decision, 2026-11-27: one field instead of
 * a separate region switcher). Production entries default first so an
 * untouched config always points at a released backend (core/config).
 */
const SERVERS: ServerEntry[] = [
  { url: TEST_API_URL, labelKey: "auth.api_config_server_test", edition: "cn" },
  { url: defaultApiUrlForEdition("cn"), labelKey: "auth.region_cn", edition: "cn" },
  { url: defaultApiUrlForEdition("intl"), labelKey: "auth.region_intl", edition: "intl" },
];

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
 * the auth gate swaps screens on its own. `onRegionChange` lets the host
 * switch its login site (edition) when the picked server belongs to another
 * one; optional because the standalone page has no login flow.
 */
export function ApiAuthPanel({
  onSuccess,
  onRegionChange,
}: {
  onSuccess?: () => void;
  onRegionChange?: (edition: LynseEdition) => void;
}) {
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
        SERVERS.some((p) => p.url === savedUrl) ? savedUrl : DEFAULT_SERVER_URL,
      );
    }
    const savedKey = localStorage.getItem("lynse_api_key");
    if (savedKey) setApiKey(savedKey);
  }, []);

  function entryFor(url: string): ServerEntry | undefined {
    return SERVERS.find((p) => p.url === url);
  }

  function serverLabel(url: string): string {
    const entry = entryFor(url);
    return entry ? t(entry.labelKey) : url;
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
   * Point this session at the selected server. The edition switch runs first
   * (its host callback resets the gateway to that edition's default), then
   * the explicit apply pins the exact picked URL on top. Switching while
   * signed in drops the session first — its token belongs to the previous
   * server.
   */
  function applySelectedServer() {
    const entry = entryFor(selectedUrl);
    if (entry) onRegionChange?.(entry.edition);
    applyServer(selectedUrl);
  }

  function handleConfirmServer() {
    if (isAuthenticated && selectedUrl !== appliedUrl) logout();
    applySelectedServer();
  }

  async function handleConnect() {
    if (!apiKey.trim()) return;
    setError(null);
    setConnecting(true);
    // Connecting always targets the currently selected server, confirmed
    // through the button above or not.
    applySelectedServer();
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

  const selectedEntry = entryFor(selectedUrl);

  return (
    <div className="space-y-3.5">
      <div className="space-y-1.5">
        <Label htmlFor="api-config-url" className="text-xs text-muted-foreground">
          {t("auth.api_config_base_url")}
        </Label>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  id="api-config-url"
                  data-testid="api-server-select"
                  className={`flex h-9 flex-1 items-center gap-2 rounded-full bg-muted px-3.5 text-sm shadow-none transition-colors hover:bg-muted/70`}
                >
                  {selectedEntry && (
                    <RegionFlag
                      region={selectedEntry.edition}
                      className="h-3 w-[17px] shrink-0 rounded-[3px] ring-1 ring-border/40"
                    />
                  )}
                  <span className="truncate text-foreground/90">{serverLabel(selectedUrl)}</span>
                  <ChevronDown className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
                </button>
              }
            />
            <DropdownMenuContent align="start" className="w-56 p-1">
              {SERVERS.map((entry) => (
                <DropdownMenuItem
                  key={entry.url}
                  onClick={() => setSelectedUrl(entry.url)}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs"
                >
                  <RegionFlag
                    region={entry.edition}
                    className="h-3 w-[17px] shrink-0 rounded-[3px] ring-1 ring-border/40"
                  />
                  <div className="flex min-w-0 flex-col">
                    <span className="font-medium text-foreground">{t(entry.labelKey)}</span>
                    <span className="truncate font-mono text-3xs text-muted-foreground">{entry.url}</span>
                  </div>
                  {selectedUrl === entry.url && <Check className="ml-auto size-3.5 text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
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
