"use client";

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@lynse/core/auth";

import { botConfigKey } from "./config";
import { abortAllTurns } from "./turns";
import { isBotChannelActive } from "../plugins/channel-plugin-gate";
import { BOT_CHANNELS, getDesktopBotsApi } from "./types";

/**
 * Bot channel lifecycle supervisor. Lives OUTSIDE the AuthGate so it keeps
 * running after logout (the answering agent inside the gate unmounts):
 *
 * - logout  → abort every in-flight turn, stop all channels with the
 *   `logged_out` reason so the settings card shows "paused, not broken"
 *   (previously the Rust connection kept receiving messages nobody answered);
 * - login   → restart every enabled channel (the config query caches are
 *   refreshed so the settings card reflects reality immediately).
 *
 * While the session is still restoring (`isLoading`) it does nothing, and a
 * logged-in first evaluation also does nothing — the Rust-side auto-start
 * already owns app-boot. Only a logged-out boot needs the correction (stopping
 * the auto-started connection), because `feishu::spawn` runs before the
 * webview knows whether a session exists.
 */
export function BotAuthSupervisor() {
  const qc = useQueryClient();
  const isLoading = useAuthStore((s) => s.isLoading);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  // null = not yet evaluated; only actual transitions (plus a logged-out
  // first evaluation) drive actions.
  const prevAuth = useRef<boolean | null>(null);

  useEffect(() => {
    const api = getDesktopBotsApi();
    if (!api || isLoading) return;
    if (prevAuth.current === isAuthenticated) return;
    const initialEvaluation = prevAuth.current === null;
    prevAuth.current = isAuthenticated;

    if (!isAuthenticated) {
      abortAllTurns();
      for (const channel of BOT_CHANNELS) {
        if (!isBotChannelActive(channel)) continue;
        api.stop(channel, "logged_out").catch(() => undefined);
      }
      return;
    }
    if (initialEvaluation) return;

    // Fresh login: restore enabled channels and refresh cached configs.
    for (const channel of BOT_CHANNELS) {
      if (!isBotChannelActive(channel)) continue;
      api
        .config(channel)
        .then((config) => {
          qc.setQueryData(botConfigKey(channel), config);
          if (config.enabled) {
            return api.start(channel);
          }
          return undefined;
        })
        .catch(() => undefined);
    }
  }, [isAuthenticated, isLoading, qc]);

  return null;
}
