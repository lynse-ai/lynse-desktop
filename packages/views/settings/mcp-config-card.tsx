"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Label } from "@lynse/ui/components/ui/label";
import { Switch } from "@lynse/ui/components/ui/switch";
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import { Copy, Plug } from "../icons";

interface Config { enabled: boolean; port: number; token: string }
interface DesktopMcpApi {
  getConfig: () => Promise<Config>;
  configure: (enabled: boolean, port: number, rotate?: boolean) => Promise<Config>;
}
function bridge(): DesktopMcpApi | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { desktopAPI?: { mcp?: DesktopMcpApi } }).desktopAPI?.mcp ?? null;
}

/** Only the native desktop host exposes the MCP settings bridge. */
export function McpConfigCard() {
  const { t } = useTranslation();
  const native = bridge();
  const [config, setConfig] = useState<Config | null>(null);
  const [port, setPort] = useState("27125");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void native?.getConfig().then((value) => {
      if (active) { setConfig(value); setPort(String(value.port)); }
    }).catch(() => { if (active) setError(t("mcp.load_failed")); });
    return () => { active = false; };
  }, [native, t]);
  if (!native) return null;

  async function update(enabled: boolean, rotate = false) {
    if (!native || busy) return;
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1 || value > 65535) { setError(t("mcp.invalid_port")); return; }
    setBusy(true);
    setError("");
    try { setConfig(await native.configure(enabled, value, rotate)); }
    catch { setError(t("mcp.start_failed")); }
    finally { setBusy(false); }
  }
  async function copy(client: "codex" | "workbuddy") {
    if (!config?.enabled) return;
    const url = `http://127.0.0.1:${config.port}/mcp`;
    const authorization = `Bearer ${config.token}`;
    const text = client === "codex"
      ? `[mcp_servers.lynse_desktop]\nurl = ${JSON.stringify(url)}\nhttp_headers = { Authorization = ${JSON.stringify(authorization)} }\n`
      : JSON.stringify({ mcpServers:{ lynse_desktop:{ type:"streamableHttp", url, headers:{Authorization:authorization} } } }, null, 2);
    try { await navigator.clipboard.writeText(text); toast.success(t("mcp.copied")); }
    catch { toast.error(t("mcp.copy_failed")); }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-xs"><Plug className="size-3.5" />{t("mcp.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="mcp-enable" className="text-xs">{t("mcp.enable")}</Label>
          <Switch id="mcp-enable" checked={config?.enabled ?? false} disabled={busy || !config} onCheckedChange={(value) => void update(value)} />
        </div>
        <p className="text-2xs leading-relaxed text-muted-foreground">{t("mcp.hint")}</p>
        <div className="flex items-center gap-3">
          <Label htmlFor="mcp-port" className="text-xs">{t("mcp.port")}</Label>
          <Input id="mcp-port" className="h-8 w-24 text-xs" type="number" min={1} max={65535} value={port} disabled={busy || config?.enabled} onChange={(event) => setPort(event.target.value)} />
        </div>
        {config?.enabled && (
          <>
            <p className="break-all rounded-md border bg-muted/30 px-2 py-1.5 text-xs">http://127.0.0.1:{config.port}/mcp</p>
            <p className="text-2xs text-muted-foreground">{t("mcp.running")}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void copy("codex")}><Copy className="size-3.5" />{t("mcp.copy_codex")}</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void copy("workbuddy")}><Copy className="size-3.5" />{t("mcp.copy_workbuddy")}</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void update(true, true)}>{t("mcp.rotate")}</Button>
            </div>
          </>
        )}
        {error && <p className="text-2xs text-destructive" role="alert">{error}</p>}
      </CardContent>
    </Card>
  );
}
