"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
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
  NativeSelect,
  NativeSelectOption,
} from "@lynse/ui/components/ui/native-select";
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import { Bot, Check, Copy, Loader2, QrCode, RefreshCw } from "../icons";
import { IconSwap } from "../icon-swap";
import { openExternalUrl } from "../app-update";
import { ChannelCardShell } from "../bots/channel-card-shell";
import { botConfigKey, useBotConfig } from "../bots/config";
import { getDesktopBotsApi, type BotChannelConfig } from "../bots/types";
import {
  getDesktopFeishuApi,
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

/** The Feishu channel's settings body, wrapped in the generic bot-channel
 *  card shell (status badge, logged-out notice, reset). Owns the enable
 *  switch (credential-gated), one-click registration, and push targets. */
export function FeishuConfigCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const bots = getDesktopBotsApi();
  const feishu = getDesktopFeishuApi();
  const { data: config } = useBotConfig("feishu");
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

  useEffect(() => {
    if (!config) return;
    setForm((previous) => ({ ...previous, ...config }));
  }, [config]);

  // Poll the device-grant session while the dialog is open; success arrives
  // with the credentials already saved (secret in the keychain, bot started).
  // Stays above the `if (!feishu) return null` guard — hooks must run in the
  // same order on every render, and the body already tolerates a missing
  // client/session.
  useEffect(() => {
    const session = registration;
    if (!feishu || !session) return;
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
      if (stopped || !feishu) return;
      try {
        const result = await feishu.registerPoll();
        intervalMs = Math.max(result.intervalSecs * 1000, fallbackIntervalMs);
        if (result.status === "success" && result.config) {
          stopped = true;
          qc.setQueryData(botConfigKey("feishu"), result.config);
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
  }, [feishu, registration, t]);

  if (!feishu) return null;

  function update(patch: Partial<FeishuConfig>) {
    setForm((previous) => ({ ...previous, ...patch }));
  }

  /** Persist the draft (and the secret when typed) and reconcile the bot. */
  async function persist(patch?: Partial<FeishuConfig>) {
    if (!bots) return;
    const next: BotChannelConfig = { ...form, ...patch };
    setSaving(true);
    try {
      const saved = await bots.save("feishu", next, secret || null);
      setSecret("");
      qc.setQueryData(botConfigKey("feishu"), saved);
      setForm((previous) => ({ ...previous, ...saved }));
    } catch (error) {
      toast.error(
        t("feishu.config_save_failed", { error: error instanceof Error ? error.message : "" }),
      );
    } finally {
      setSaving(false);
    }
  }

  function resetLocalState() {
    setForm({ ...DEFAULT_FORM });
    setSecret("");
    setChats([]);
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
    if (!feishu) return;
    setTesting(true);
    try {
      // Save first so the Rust side tests the credentials the form shows.
      await persist();
      const result = await feishu.testConnection();
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
    if (!feishu || loadingChats) return;
    setLoadingChats(true);
    try {
      // Credentials must be persisted before the Rust side can list chats.
      await persist();
      const list = await feishu.listChats();
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
    if (!feishu) return;
    try {
      await feishu.sendText(t("feishu.test_message"));
      toast.success(t("feishu.test_message_sent"));
    } catch (error) {
      toast.error(
        t("feishu.test_message_failed", { error: error instanceof Error ? error.message : "" }),
      );
    }
  }

  // ── One-click registration (device grant) ─────────────────────────────────

  /** Start the flow: ask Rust for a confirmation URL and open the QR dialog. */
  async function handleRegister() {
    if (!feishu || startingRegister) return;
    setStartingRegister(true);
    setRegisterError(null);
    try {
      const session = await feishu.registerBegin({
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
    feishu?.registerCancel().catch(() => {});
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

  return (
    <ChannelCardShell
      channelId="feishu"
      title={t("feishu.title")}
      icon={<Bot className="size-3.5" />}
      onReset={resetLocalState}
    >
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
            <IconSwap stateKey={startingRegister ? "busy" : "idle"}>
              {startingRegister ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <QrCode className="size-3.5" />
              )}
            </IconSwap>
            {t("feishu.register_button")}
          </Button>
          <p className="text-2xs leading-relaxed text-muted-foreground">
            {t("feishu.register_manual_hint")}
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
              <IconSwap stateKey={loadingChats ? "busy" : "idle"}>
                {loadingChats ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="size-3.5" />
                )}
              </IconSwap>
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
                  <IconSwap stateKey={linkCopied ? "copied" : "idle"}>
                    {linkCopied ? (
                      <Check className="size-3.5" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </IconSwap>
                  {linkCopied
                    ? t("feishu.register_copied")
                    : t("feishu.register_copy_link")}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </ChannelCardShell>
  );
}
