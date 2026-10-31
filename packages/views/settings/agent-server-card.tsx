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
import { api } from "@lynse/core/api";
import { useTranslation } from "@lynse/core/i18n/react";
import {
  AGENT_API_URL_STORAGE_KEY,
  CLOUDBASE_AGENT_URL,
  STAGING_CLOUDBASE_AGENT_URL,
  LEGACY_CLOUDBASE_AGENT_URL,
  agentUrlForApiUrl,
} from "@lynse/core/config";
import { Sparkles } from "../icons";
import { BetaBadge } from "../beta-badge";

/** Where the assistant connects. "follow" (empty setting) rides the main
 *  backend gateway; "cloudbase" is the route-B direct CloudRun preset;
 *  "custom" is a hand-typed origin. */
type AgentServerMode = "follow" | "cloudbase" | "custom";

function modeForUrl(url: string | null): AgentServerMode {
  if (!url) return "follow";
  if (url === CLOUDBASE_AGENT_URL || url === STAGING_CLOUDBASE_AGENT_URL || url === LEGACY_CLOUDBASE_AGENT_URL)
    return "cloudbase";
  return "custom";
}

function isValidServerUrl(url: string): boolean {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Persist + apply the assistant backend for this session. Empty string = follow. */
function applyAgentUrl(url: string) {
  api().setAgentBaseUrl(url || null);
  if (url) localStorage.setItem(AGENT_API_URL_STORAGE_KEY, url);
  else localStorage.removeItem(AGENT_API_URL_STORAGE_KEY);
}

/**
 * Server-address picker for the Xiaoling (小灵助手) assistant. "follow" rides
 * the main Lynse backend (gateway-fronted agent routes); "cloudbase" points
 * straight at the CloudBase-hosted lynclaw deployment (route B, bypassing the
 * gateway — the default after login via the agent-URL mapping); "custom"
 * targets a hand-typed origin. Applies immediately — the chat transport reads
 * the base URL per request, so mid-conversation switches land on the next
 * turn.
 */
export function AgentServerCard() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<AgentServerMode>("follow");
  const [customUrl, setCustomUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mainUrl, setMainUrl] = useState("");
  const [agentUrl, setAgentUrl] = useState<string | null>(null);

  useEffect(() => {
    try {
      setMainUrl(api().getBaseUrl());
      const saved = api().getAgentBaseUrl();
      setAgentUrl(saved);
      const savedMode = modeForUrl(saved);
      setMode(savedMode);
      if (savedMode === "custom") setCustomUrl(saved ?? "");
    } catch {
      // Client not initialized (should not happen inside the app shell).
    }
  }, []);

  function switchMode(next: AgentServerMode) {
    setMode(next);
    setError(null);
    if (next === "follow") {
      applyAgentUrl("");
      setAgentUrl(null);
    } else if (next === "cloudbase") {
      const target = agentUrlForApiUrl(api().getBaseUrl()) ?? CLOUDBASE_AGENT_URL;
      applyAgentUrl(target);
      setAgentUrl(target);
    }
    // "custom" keeps the previous target until a valid URL is typed below.
  }

  function handleCustomUrl(value: string) {
    setCustomUrl(value);
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!trimmed) {
      // Cleared: fall back to following the main backend.
      setError(null);
      applyAgentUrl("");
      setAgentUrl(null);
      setMode("follow");
      return;
    }
    if (!isValidServerUrl(trimmed)) {
      setError(t("settings.agent_server_invalid"));
      return;
    }
    setError(null);
    applyAgentUrl(trimmed);
    setAgentUrl(trimmed);
  }

  const currentTarget = agentUrl
    ? agentUrl
    : `${t("settings.agent_server_follow")} · ${mainUrl}`;

  const modeItems = {
    follow: t("settings.agent_server_follow"),
    cloudbase: t("settings.agent_server_cloudbase"),
    custom: t("settings.agent_server_custom"),
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-xs">
          <Sparkles className="size-3.5" />
          {t("settings.agent_server_title")}
          <BetaBadge />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-2xs leading-relaxed text-muted-foreground">
          {t("settings.agent_server_hint")}
        </p>

        <div className="space-y-1.5">
          <Label htmlFor="agent-server-url" className="text-xs text-muted-foreground">
            {t("settings.agent_server_label")}
          </Label>
          <Select
            value={mode}
            items={modeItems}
            onValueChange={(value) => switchMode(value as AgentServerMode)}
          >
            <SelectTrigger id="agent-server-url" className="h-9 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="follow">{t("settings.agent_server_follow")}</SelectItem>
              <SelectItem value="cloudbase">{t("settings.agent_server_cloudbase")}</SelectItem>
              <SelectItem value="custom">{t("settings.agent_server_custom")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {mode === "custom" && (
          <div className="space-y-1.5">
            <Input
              id="agent-server-custom-url"
              placeholder="https://…"
              value={customUrl}
              onChange={(e) => handleCustomUrl(e.target.value)}
              className="h-9 text-xs"
              spellCheck={false}
            />
            <p className="text-2xs text-muted-foreground">{CLOUDBASE_AGENT_URL}</p>
          </div>
        )}

        {error && <p className="text-2xs leading-relaxed text-destructive">{error}</p>}

        <p className="text-2xs leading-relaxed text-muted-foreground">
          {t("settings.agent_server_current", { target: currentTarget })}
        </p>
      </CardContent>
    </Card>
  );
}
