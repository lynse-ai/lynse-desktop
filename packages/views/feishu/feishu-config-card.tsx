"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Badge } from "@lynse/ui/components/ui/badge";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Label } from "@lynse/ui/components/ui/label";
import { Switch } from "@lynse/ui/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@lynse/ui/components/ui/alert-dialog";
import {
  NativeSelect,
  NativeSelectOption,
} from "@lynse/ui/components/ui/native-select";
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import { Bot, Check, Copy, Loader2, QrCode, RefreshCw, Trash2 } from "../icons";
import { openExternalUrl } from "../app-update";
import {
  getDesktopFeishuApi,
  FEISHU_CONFIG_QUERY_KEY,
  useFeishuConfig,
  useFeishuStatus,
  type FeishuChatSummary,
  type FeishuConfig,
  type FeishuRegistrationStart,
} from "./feishu";

const DEFAULT_FORM: FeishuConfig = {
  appId: "",
  targetChatId: "",
  enabled: false,
  pushSummary: true,
  hasSecret: false,
};

function stateBadgeVariant(state: string): "default" | "secondary" | "destructive" | "outline" {
  if (state === "online") return "default";
  if (state === "error") return "destructive";
  if (state === "disabled") return "outline";
  return "secondary";
}

/** Settings card for the Feishu bot (desktop only). Renders nothing when the
 *  bridge is unavailable (web). The App Secret goes to the OS keychain and is
 *  never displayed back. */
export function FeishuConfigCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const api = getDesktopFeishuApi();
  const { data: config } = useFeishuConfig();
  const { data: status } = useFeishuStatus();
  const [form, setForm] = useState<FeishuConfig>(DEFAULT_FORM);
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [loadingChats, setLoadingChats] = useState(false);
  const [chats, setChats] = useState<FeishuChatSummary[]>([]);
  /** Active one-click registration; non-null opens the QR dialog. */
  const [registration, setRegistration] = useState<FeishuRegistrationStart | null>(null);
  const [registerError, setRegisterError] = useState<{ key: string; error?: string } | null>(null);
  const [startingRegister, setStartingRegister] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (!config) return;
    setForm((previous) => ({ ...previous, ...config }));
  }, [config]);

  if (!api) return null;

  const stateKey =
    status?.state === "online"
      ? "feishu.state_online"
      : status?.state === "connecting"
        ? "feishu.state_connecting"
        : status?.state === "reconnecting"
          ? "feishu.state_reconnecting"
          : status?.state === "error"
            ? "feishu.state_error"
            : "feishu.state_disabled";

  function update(patch: Partial<FeishuConfig>) {
    setForm((previous) => ({ ...previous, ...patch }));
  }

  /** Persist the draft (and the secret when typed) and reconcile the bot. */
  async function persist(patch?: Partial<FeishuConfig>) {
    if (!api) return;
    const next = { ...form, ...patch };
    setSaving(true);
    try {
      const saved = await api.saveConfig(next, secret || null);
      setSecret("");
      qc.setQueryData(FEISHU_CONFIG_QUERY_KEY, saved);
      setForm((previous) => ({ ...previous, ...saved }));
    } catch (error) {
      toast.error(
        t("feishu.config_save_failed", { error: error instanceof Error ? error.message : "" }),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(enabled: boolean) {
    const hasCredentials = form.appId.trim() && (secret || form.hasSecret);
    if (enabled && !hasCredentials) {
      // Fields are hidden while the bot is off; reveal the form so the user
      // can fill them in. Persist the switch only once they are complete.
      update({ enabled: true });
      return;
    }
    await persist({ enabled });
  }

  async function handleTestConnection() {
    if (!api) return;
    setTesting(true);
    try {
      // Save first so the Rust side tests the credentials the form shows.
      await persist();
      const result = await api.testConnection();
      toast.success(t("feishu.test_ok", { name: result.botName || result.openId }));
    } catch (error) {
      toast.error(
        t("feishu.test_failed", { error: error instanceof Error ? error.message : "" }),
      );
    } finally {
      setTesting(false);
    }
  }

  async function handleLoadChats() {
    if (!api || loadingChats) return;
    setLoadingChats(true);
    try {
      // Credentials must be persisted before the Rust side can list chats.
      await persist();
      const list = await api.listChats();
      setChats(list.filter((chat) => chat.chatId));
      if (list.length === 0) toast.warning(t("feishu.chats_empty"));
    } catch (error) {
      toast.error(
        t("feishu.chats_failed", { error: error instanceof Error ? error.message : "" }),
      );
    } finally {
      setLoadingChats(false);
    }
  }

  async function handleSendTestMessage() {
    if (!api) return;
    try {
      await api.sendText(t("feishu.test_message"));
      toast.success(t("feishu.test_message_sent"));
    } catch (error) {
      toast.error(
        t("feishu.test_message_failed", { error: error instanceof Error ? error.message : "" }),
      );
    }
  }

  /** Wipe the bot setup (stop, drop the keychain secret, clear config) so
   *  one-click registration can start from scratch. */
  async function handleReset() {
    if (!api || resetting) return;
    setResetting(true);
    try {
      const fresh = await api.resetConfig();
      qc.setQueryData(FEISHU_CONFIG_QUERY_KEY, fresh);
      setForm({ ...DEFAULT_FORM });
      setSecret("");
      setChats([]);
      toast.success(t("feishu.reset_done"));
    } catch (error) {
      toast.error(
        t("feishu.reset_failed", { error: error instanceof Error ? error.message : "" }),
      );
    } finally {
      setResetting(false);
      setResetConfirmOpen(false);
    }
  }

  // ── One-click registration (device grant) ─────────────────────────────────

  /** Start the flow: ask Rust for a confirmation URL and open the QR dialog. */
  async function handleRegister() {
    if (!api || startingRegister) return;
    setStartingRegister(true);
    setRegisterError(null);
    try {
      const session = await api.registerBegin({
        name: t("feishu.register_app_name"),
        desc: t("feishu.register_app_desc"),
      });
      setRegistration(session);
    } catch (error) {
      toast.error(
        t("feishu.register_failed", { error: error instanceof Error ? error.message : "" }),
      );
    } finally {
      setStartingRegister(false);
    }
  }

  /** Close the dialog and drop the Rust-side session. */
  function handleCancelRegistration() {
    api?.registerCancel().catch(() => {});
    setRegistration(null);
    setRegisterError(null);
  }

  async function handleCopyRegistrationLink() {
    if (!registration) return;
    try {
      await navigator.clipboard.writeText(registration.url);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      /* clipboard unavailable — the open-link button still works */
    }
  }

  // Poll the device-grant session while the dialog is open; success arrives
  // with the credentials already saved (secret in the keychain, bot started).
  useEffect(() => {
    const session = registration;
    if (!api || !session) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fallbackIntervalMs = Math.max(session.intervalSecs, 1) * 1000;
    let intervalMs = fallbackIntervalMs;
    const deadline = Date.now() + session.expiresInSecs * 1000;

    function fail(key: string, error?: string) {
      stopped = true;
      setRegisterError({ key, error });
    }

    async function tick() {
      if (stopped || !api) return;
      try {
        const result = await api.registerPoll();
        intervalMs = Math.max(result.intervalSecs * 1000, fallbackIntervalMs);
        if (result.status === "success" && result.config) {
          stopped = true;
          qc.setQueryData(FEISHU_CONFIG_QUERY_KEY, result.config);
          setForm((previous) => ({ ...previous, ...result.config! }));
          setSecret("");
          toast.success(t("feishu.register_success"));
          setRegistration(null);
          return;
        }
        if (result.status === "denied") return fail("feishu.register_denied");
        if (result.status === "expired") return fail("feishu.register_expired");
        if (result.status === "failed") return fail("feishu.register_failed", result.error ?? "");
      } catch {
        /* transport hiccup — keep trying until the confirmation URL expires */
      }
      if (Date.now() >= deadline) return fail("feishu.register_expired");
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }

    timer = setTimeout(tick, intervalMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only on a fresh session
  }, [api, registration, t]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-xs">
          <Bot className="size-3.5" />
          {t("feishu.title")}
          <Badge variant={stateBadgeVariant(status?.state ?? "disabled")} className="ml-auto text-2xs">
            {t(stateKey)}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="feishu-enable" className="text-xs">
            {t("feishu.enable")}
          </Label>
          <Switch
            id="feishu-enable"
            checked={form.enabled}
            onCheckedChange={handleToggle}
            disabled={saving}
          />
        </div>
        <p className="text-2xs leading-relaxed text-muted-foreground">{t("feishu.hint")}</p>
        {(!form.appId.trim() || !form.hasSecret) && (
          <>
            <Button
              size="sm"
              className="h-8 w-full text-xs"
              onClick={handleRegister}
              disabled={startingRegister}
            >
              {startingRegister ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <QrCode className="size-3.5" />
              )}
              {t("feishu.register_button")}
            </Button>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              {t("feishu.register_manual_hint")}
            </p>
          </>
        )}
        {status?.state === "error" && status?.error ? (
          <p className="text-2xs leading-relaxed text-destructive">{status.error}</p>
        ) : null}

        {(form.appId.trim() || form.hasSecret) && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-full text-xs text-destructive hover:text-destructive"
              onClick={() => setResetConfirmOpen(true)}
              disabled={resetting}
            >
              {resetting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              {t("feishu.reset_button")}
            </Button>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              {t("feishu.reset_hint")}
            </p>
          </>
        )}

        {form.enabled && (
          <>
            <div className="space-y-2">
              <Label htmlFor="feishu-app-id" className="text-xs">
                App ID
              </Label>
              <Input
                id="feishu-app-id"
                className="h-8 text-xs"
                placeholder="cli_a5..."
                autoComplete="off"
                value={form.appId}
                onChange={(event) => update({ appId: event.target.value })}
                onBlur={() => persist()}
                disabled={saving}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="feishu-app-secret" className="text-xs">
                App Secret
              </Label>
              <Input
                id="feishu-app-secret"
                className="h-8 text-xs"
                type="password"
                autoComplete="new-password"
                placeholder={form.hasSecret ? t("feishu.secret_stored") : ""}
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                onBlur={() => {
                  if (secret) persist();
                }}
                disabled={saving}
              />
            </div>

            <div className="flex items-center justify-between gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={handleTestConnection}
                disabled={testing || !form.appId.trim()}
              >
                {testing && <Loader2 className="size-3.5 animate-spin" />}
                {t("feishu.test_connection")}
              </Button>
            </div>

            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="feishu-push-summary" className="text-xs">
                {t("feishu.push_summary")}
              </Label>
              <Switch
                id="feishu-push-summary"
                checked={form.pushSummary}
                onCheckedChange={(value) => persist({ pushSummary: value })}
                disabled={saving}
              />
            </div>

            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
              <div className="space-y-2">
                <Label htmlFor="feishu-target-chat" className="text-xs">
                  {t("feishu.target_chat")}
                </Label>
                <NativeSelect
                  id="feishu-target-chat"
                  className="h-8 text-xs"
                  value={form.targetChatId}
                  onChange={(event) => persist({ targetChatId: event.target.value })}
                  disabled={saving || chats.length === 0}
                >
                  <NativeSelectOption value="">
                    {form.targetChatId
                      ? form.targetChatId
                      : t("feishu.chat_none")}
                  </NativeSelectOption>
                  {chats
                    .filter((chat) => chat.chatId !== form.targetChatId)
                    .map((chat) => (
                      <NativeSelectOption key={chat.chatId} value={chat.chatId}>
                        {chat.name || chat.chatId}
                      </NativeSelectOption>
                    ))}
                </NativeSelect>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={handleLoadChats}
                disabled={loadingChats || !form.appId.trim() || !(form.hasSecret || secret)}
              >
                {loadingChats ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
                {t("feishu.refresh_chats")}
              </Button>
            </div>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              {t("feishu.target_chat_hint")}
            </p>

            <div className="flex items-center justify-end">
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={handleSendTestMessage}
                disabled={!form.targetChatId}
              >
                {t("feishu.send_test_message")}
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <Dialog
        open={!!registration}
        onOpenChange={(open) => {
          if (!open) handleCancelRegistration();
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              <QrCode className="size-4" />
              {t("feishu.register_title")}
            </DialogTitle>
          </DialogHeader>
          {registration && (
            <div className="space-y-3">
              <div className="flex flex-col items-center gap-2">
                <div className="rounded-lg border bg-white p-2">
                  <QRCodeSVG value={registration.url} size={160} />
                </div>
                {registerError ? (
                  <p className="text-2xs leading-relaxed text-destructive">
                    {t(registerError.key, { error: registerError.error ?? "" })}
                  </p>
                ) : (
                  <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    {t("feishu.register_waiting")}
                  </p>
                )}
              </div>
              <p className="text-2xs leading-relaxed text-muted-foreground">
                {t("feishu.register_hint")}
              </p>
              <div className="flex items-center justify-between gap-2">
                {registerError ? (
                  <Button size="sm" className="h-8 text-xs" onClick={handleRegister}>
                    {t("feishu.register_retry")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    onClick={() => openExternalUrl(registration.url)}
                  >
                    {t("feishu.register_open_link")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs"
                  onClick={handleCopyRegistrationLink}
                >
                  {linkCopied ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  {linkCopied
                    ? t("feishu.register_copied")
                    : t("feishu.register_copy_link")}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={resetConfirmOpen}
        onOpenChange={(open) => {
          if (!resetting) setResetConfirmOpen(open);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("feishu.reset_confirm_title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("feishu.reset_confirm_desc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm" className="h-8 text-xs">
              {t("feishu.reset_cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              className="h-8 text-xs"
              onClick={handleReset}
              disabled={resetting}
            >
              {resetting && <Loader2 className="size-3.5 animate-spin" />}
              {t("feishu.reset_confirm_action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
