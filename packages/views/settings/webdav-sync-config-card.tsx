"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Label } from "@lynse/ui/components/ui/label";
import { Switch } from "@lynse/ui/components/ui/switch";
import { useTheme } from "@lynse/ui/components/common/theme-provider";
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "../icons";
import { useNotes } from "../workspace/hooks/use-files";
import {
  applySettingsBundle,
  collectSettingsBundle,
  getDesktopWebdavSyncApi,
  markWebdavNotesLastSync,
  syncNotesToWebdav,
  useWebdavSyncConfig,
  WEBDAV_CONFIG_QUERY_KEY,
  type WebdavSyncConfig,
} from "./webdav-sync";

function toApiDateTime(d: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const DEFAULT_FORM: WebdavSyncConfig = {
  enabled: false,
  url: "",
  username: "",
  remotePath: "Lynse",
  autoSync: true,
  allowSelfSigned: false,
  lastSyncAt: null,
  hasPassword: false,
};

function text(input: unknown): string {
  return typeof input === "string" ? input : "";
}

/** Settings card for WebDAV sync (desktop only). Renders nothing when the
 *  bridge is unavailable (web). Credentials never appear in the synced
 *  bundle: the password goes to the OS keychain only. */
export function WebdavSyncConfigCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { setTheme } = useTheme();
  const api = getDesktopWebdavSyncApi();
  const { data: config } = useWebdavSyncConfig();
  const [form, setForm] = useState<WebdavSyncConfig>(DEFAULT_FORM);
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // "All my meetings" — same wide range the notes page and vault card use,
  // so the push covers exactly the notes the user sees there.
  const endTime = useMemo(() => toApiDateTime(new Date()), []);
  const { data: notes } = useNotes({ startTime: "2020-01-01T00:00:00", endTime });

  useEffect(() => {
    if (!config) return;
    setForm((previous) => ({ ...previous, ...config }));
  }, [config]);

  if (!api) return null;

  function update(patch: Partial<WebdavSyncConfig>) {
    setForm((previous) => ({ ...previous, ...patch }));
  }

  /** Persist the draft and (when typed) the password, then clear the field
   *  so the secret is never visibly sticky in the dialog. */
  async function persist(patch?: Partial<WebdavSyncConfig>) {
    if (!api) return;
    const next = { ...form, ...patch };
    setSaving(true);
    try {
      if (password) {
        await api.setPassword(password);
        setPassword("");
      }
      const saved = await api.saveConfig(next);
      qc.setQueryData(WEBDAV_CONFIG_QUERY_KEY, saved);
      setForm((previous) => ({ ...previous, ...saved }));
    } catch (error) {
      toast.error(
        t("webdav.config_save_failed", { error: error instanceof Error ? error.message : "" }),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(enabled: boolean) {
    const hasCredentials = form.url.trim() && form.username.trim() && (password || form.hasPassword);
    if (enabled && !hasCredentials) {
      // Fields are hidden while sync is off; reveal the form so the user can
      // fill them in. Persist the enabled state only once they are complete.
      update({ enabled: true });
      return;
    }
    await persist({ enabled });
  }

  async function handleTestConnection() {
    if (!api) return;
    setTesting(true);
    try {
      await api.testConnection(form, password);
      toast.success(t("webdav.test_ok"));
    } catch (error) {
      toast.error(
        t("webdav.test_failed", { error: error instanceof Error ? error.message : "" }),
      );
    } finally {
      setTesting(false);
    }
  }

  async function handleSyncNow() {
    if (!api || syncing) return;
    setSyncing(true);
    const loadingToastId = toast.loading(t("webdav.sync_started"));
    try {
      const bundle = await collectSettingsBundle();
      const summary = await api.syncNow(bundle);
      if (summary.settingsToApply) {
        await applySettingsBundle(summary.settingsToApply, { setTheme });
      }
      const labels = { outline: t("vault.section_outline"), summary: t("vault.section_summary") };
      const notesSummary = await syncNotesToWebdav(notes ?? [], labels).catch(() => null);
      if (notesSummary) markWebdavNotesLastSync();

      const notesPart = notesSummary
        ? t("webdav.sync_notes_part", {
            written: notesSummary.written,
            failed: notesSummary.failed,
          })
        : "";
      const detail = t("webdav.sync_summary", {
        pushed: summary.pushed,
        pulled: summary.pulled,
        deletions: summary.deletions,
        notes: notesPart,
      }).trim();
      if (summary.conflicts > 0) {
        toast.warning(
          `${t("webdav.sync_done_with_conflicts", { conflicts: summary.conflicts })}\n${detail}`,
          { id: loadingToastId },
        );
      } else {
        toast.success(`${t("webdav.sync_done")}\n${detail}`, { id: loadingToastId });
      }
    } catch (error) {
      toast.error(
        t("webdav.sync_failed", { error: error instanceof Error ? error.message : "" }),
        { id: loadingToastId },
      );
    } finally {
      setSyncing(false);
    }
  }

  const lastSync = form.lastSyncAt
    ? t("webdav.last_sync", { time: new Date(form.lastSyncAt).toLocaleString() })
    : t("webdav.never_synced");

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs">{t("webdav.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="webdav-enable" className="text-xs">
            {t("webdav.enable")}
          </Label>
          <Switch
            id="webdav-enable"
            checked={form.enabled}
            onCheckedChange={handleToggle}
            disabled={saving}
          />
        </div>
        <p className="text-2xs leading-relaxed text-muted-foreground text-pretty">{t("webdav.hint")}</p>

        {form.enabled && (
          <>
            <div className="space-y-2">
              <Label htmlFor="webdav-url" className="text-xs">
                {t("webdav.url")}
              </Label>
              <Input
                id="webdav-url"
                className="h-8 text-xs"
                placeholder="https://dav.jianguoyun.com/dav/"
                value={form.url}
                onChange={(event) => update({ url: event.target.value })}
                onBlur={() => persist()}
                disabled={saving}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2">
                <Label htmlFor="webdav-username" className="text-xs">
                  {t("webdav.username")}
                </Label>
                <Input
                  id="webdav-username"
                  className="h-8 text-xs"
                  autoComplete="off"
                  value={form.username}
                  onChange={(event) => update({ username: event.target.value })}
                  onBlur={() => persist()}
                  disabled={saving}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="webdav-password" className="text-xs">
                  {t("webdav.password")}
                </Label>
                <Input
                  id="webdav-password"
                  className="h-8 text-xs"
                  type="password"
                  autoComplete="new-password"
                  placeholder={form.enabled ? t("webdav.password_stored") : ""}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  onBlur={() => {
                    if (password) persist();
                  }}
                  disabled={saving}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 items-end gap-2">
              <div className="space-y-2">
                <Label htmlFor="webdav-remote-path" className="text-xs">
                  {t("webdav.remote_path")}
                </Label>
                <Input
                  id="webdav-remote-path"
                  className="h-8 text-xs"
                  value={text(form.remotePath)}
                  onChange={(event) => update({ remotePath: event.target.value })}
                  onBlur={() => persist()}
                  disabled={saving}
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={handleTestConnection}
                disabled={testing || !form.url.trim() || !form.username.trim()}
              >
                {testing && <Loader2 className="size-3.5 animate-spin" />}
                {t("webdav.test_connection")}
              </Button>
            </div>

            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="webdav-auto-sync" className="text-xs">
                {t("webdav.auto_sync")}
              </Label>
              <Switch
                id="webdav-auto-sync"
                checked={form.autoSync}
                onCheckedChange={(value) => persist({ autoSync: value })}
                disabled={saving || !form.enabled}
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="webdav-self-signed" className="text-xs">
                {t("webdav.allow_self_signed")}
              </Label>
              <Switch
                id="webdav-self-signed"
                checked={form.allowSelfSigned}
                onCheckedChange={(value) => persist({ allowSelfSigned: value })}
                disabled={saving || !form.enabled}
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="text-2xs text-muted-foreground">{lastSync}</span>
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={handleSyncNow}
                disabled={syncing || !form.enabled}
              >
                {syncing ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {t("webdav.sync_now")}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
