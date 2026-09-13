"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@lynse/ui/components/ui/card";
import { Badge } from "@lynse/ui/components/ui/badge";
import { Button } from "@lynse/ui/components/ui/button";
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
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import { Loader2, Trash2 } from "../icons";
import { IconSwap } from "../icon-swap";
import { botConfigKey, useBotState } from "./config";
import { getDesktopBotsApi, type BotChannelState } from "./types";

function stateBadgeVariant(state: string): "default" | "secondary" | "destructive" | "outline" {
  if (state === "online") return "default";
  if (state === "error") return "destructive";
  if (state === "disabled") return "outline";
  return "secondary";
}

function stateTextKey(state: BotChannelState): string {
  return `bots.state_${state}`;
}

interface ChannelCardShellProps {
  /** Channel id ("feishu") — drives the status query and reset command. */
  channelId: string;
  /** Already-translated card title (each channel owns its name). */
  title: string;
  icon: React.ReactNode;
  /** Channel-specific settings: enable switch, credentials, targets… */
  children: React.ReactNode;
  /** Extra local cleanup after a successful reset (forms, loaded lists). */
  onReset?: () => void;
}

/**
 * Generic bot-channel settings card: header with live status badge, a
 * "paused because logged out" notice, the channel's own settings body, and
 * the reset action (stop + wipe secrets + restore defaults) with confirm.
 */
export function ChannelCardShell({
  channelId,
  title,
  icon,
  children,
  onReset,
}: ChannelCardShellProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const api = getDesktopBotsApi();
  const { data: status } = useBotState(channelId);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const state = status?.state ?? "disabled";

  // Bot channels are a desktop capability; render nothing on web so shared
  // settings keep their layout. (Hooks above stay unconditional.)
  if (!api) return null;

  /** Wipe the channel setup (stop, drop keychain secrets, restore defaults)
   *  so its first-run flow can start from scratch. */
  async function handleReset() {
    if (!api || resetting) return;
    setResetting(true);
    try {
      const fresh = await api.reset(channelId);
      qc.setQueryData(botConfigKey(channelId), fresh);
      onReset?.();
      toast.success(t("bots.reset_done"));
    } catch (error) {
      toast.error(
        t("bots.reset_failed", { error: error instanceof Error ? error.message : "" }),
      );
    } finally {
      setResetting(false);
      setResetConfirmOpen(false);
    }
  }

  // The card renders even without the bridge so web builds keep their layout;
  // every action inside requires the bridge anyway.
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-xs">
          {icon}
          {title}
          <Badge variant={stateBadgeVariant(state)} className="ms-auto text-2xs">
            {t(stateTextKey(state))}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {status?.reason === "logged_out" ? (
          <p className="text-2xs leading-relaxed text-muted-foreground text-pretty">
            {t("bots.paused_logged_out")}
          </p>
        ) : null}
        {children}
        <Button
          size="sm"
          variant="outline"
          className="h-8 w-full text-xs text-destructive hover:text-destructive"
          onClick={() => setResetConfirmOpen(true)}
          disabled={resetting}
        >
          <IconSwap stateKey={resetting ? "busy" : "idle"}>
            {resetting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </IconSwap>
          {t("bots.reset_button")}
        </Button>
        <p className="text-2xs leading-relaxed text-muted-foreground text-pretty">
          {t("bots.reset_hint")}
        </p>
      </CardContent>

      <AlertDialog
        open={resetConfirmOpen}
        onOpenChange={(open) => {
          if (!resetting) setResetConfirmOpen(open);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("bots.reset_confirm_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("bots.reset_confirm_desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="sm" className="h-8 text-xs">
              {t("bots.reset_cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              size="sm"
              variant="destructive"
              className="h-8 text-xs"
              onClick={handleReset}
              disabled={resetting}
            >
              {resetting && <Loader2 className="size-3.5 animate-spin" />}
              {t("bots.reset_confirm_action")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
