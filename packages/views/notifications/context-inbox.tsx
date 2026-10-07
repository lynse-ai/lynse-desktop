"use client";

import { useEffect, useLayoutEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAuthStore, useAuthStore } from "@lynse/core/auth";
import { api } from "@lynse/core/api/client";
import { actOnContextInbox, getContextInboxItem, listContextInbox, syncContextMeetings } from "@lynse/core/api";
import type { ContextInboxAction, ContextInboxItem, ContextInboxResponse } from "@lynse/core/api";
import { useChatStore } from "../workspace/hooks/use-chat-store";
import { useNotificationStore, type NotificationItem } from "./use-notification-store";

interface InboxController {
  userId: string;
  current: () => boolean;
  action: (item: ContextInboxItem, action: ContextInboxAction) => Promise<void>;
  open: (item: ContextInboxItem, push: (path: string) => void) => Promise<void>;
}

let activeInbox: InboxController | null = null;

export async function actOnContextNotification(notification: NotificationItem, action: ContextInboxAction) {
  const context = notification.context;
  const controller = activeInbox;
  if (!context || controller?.userId !== context.userId || !controller.current()) return;
  if (action === "displayed" && (!context.canDisplay || context.item.displayed_at)) return;
  await controller.action(context.item, action);
}

export async function openContextNotification(notification: NotificationItem, push: (path: string) => void) {
  const context = notification.context;
  const controller = activeInbox;
  if (!context || controller?.userId !== context.userId || !controller.current()) return;
  await controller.open(context.item, push);
}

/** Kept outside AuthGate so logout always cancels requests and removes the mirror. */
export function ContextInboxNotifier() {
  const authenticated = useAuthStore((s) => s.isAuthenticated);
  const knownUserId = useAuthStore((s) => s.user?.id ?? null);
  const sessionToken = authenticated ? api().getToken() : null;
  const queryClient = useQueryClient();
  // Query keys contain a disposable session ID, never the login credential.
  const sessionId = useMemo(() => authenticated && sessionToken
    ? `${knownUserId ?? "verified-by-server"}:${crypto.randomUUID()}` : "signed-out", [authenticated, knownUserId, sessionToken]);
  const queryKey = useMemo(() => ["context-inbox", sessionId], [sessionId]);
  const inbox = useQuery({
    queryKey,
    queryFn: ({ signal }) => listContextInbox(sessionToken!, signal),
    enabled: !!sessionToken,
    staleTime: 0,
    retry: false,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  useLayoutEffect(() => {
    const store = useNotificationStore.getState();
    store.setContextUser(null);
    activeInbox = null;
    useChatStore.getState().switchUser(null);
    return () => {
      activeInbox = null;
      useNotificationStore.getState().setContextUser(null);
      void queryClient.cancelQueries({ queryKey });
      queryClient.removeQueries({ queryKey });
    };
  }, [queryClient, queryKey]);

  const userId = sessionToken && inbox.data && !inbox.isError
    && (!knownUserId || knownUserId === inbox.data.user_id) ? inbox.data.user_id : null;
  useEffect(() => {
    if (!sessionToken || !userId) {
      activeInbox = null;
      useNotificationStore.getState().setContextUser(null);
      return;
    }
    if (!knownUserId) {
      // API-key/restored sessions may lack a profile. Use only the identity
      // derived by the server from this exact token before opening any chat.
      if (api().getToken() === sessionToken) {
        getAuthStore()?.getState().setUser({ id: userId, name: "", email: "" });
      }
      return;
    }
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && api().getToken() === sessionToken
      && useNotificationStore.getState().contextUserId === userId;
    const operations = new Map<string, { id: string; snoozedUntil?: string }>();
    const inFlight = new Map<string, Promise<void>>();
    let displayInFlight: Promise<void> | null = null;
    useNotificationStore.getState().setContextUser(userId);
    activeInbox = {
      userId,
      current,
      action: (item, action) => {
        const key = `${item.item_id}:${item.version}:${action}`;
        const pending = inFlight.get(key);
        if (pending) return pending;
        if (!current()) return Promise.resolve();
        if (action === "displayed") {
          if (displayInFlight || !queryClient.getQueryData<ContextInboxResponse>(queryKey)?.can_display) return Promise.resolve();
        }
        const operation = operations.get(key) ?? {
          id: crypto.randomUUID(),
          snoozedUntil: action === "snooze" ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : undefined,
        };
        operations.set(key, operation);
        const run = (async () => {
          const result = await actOnContextInbox(item, action, sessionToken, operation.id, operation.snoozedUntil, controller.signal);
          if (!current()) return;
          queryClient.setQueryData<ContextInboxResponse>(queryKey, (old) => old ? {
            ...old,
            can_display: action === "displayed" ? false : old.can_display,
            items: old.items.map((entry) => entry.item_id === item.item_id ? result.item : entry),
          } : old);
        })().finally(() => {
          inFlight.delete(key);
          if (action === "displayed") displayInFlight = null;
        });
        inFlight.set(key, run);
        if (action === "displayed") displayInFlight = run;
        return run;
      },
      open: async (item, push) => {
        const detail = await getContextInboxItem(item.item_id, sessionToken, controller.signal);
        if (!current()) return;
        if (detail.user_id !== userId || detail.item.status !== "pending") throw new Error("Context suggestion changed");
        const chat = useChatStore.getState();
        chat.setUserId(userId);
        chat.hydrate();
        chat.setActiveAssistant("lynse");
        chat.clearMessages();
        push("/chat");
        // A user request follows the usual transport and confirmation protocol.
        chat.sendMessage(`查看上下文建议 ${item.item_id}`, undefined, false, undefined, { assistant: "lynse" });
      },
    };
    const synchronize = () => {
      if (document.visibilityState === "visible" && current()) {
        void syncContextMeetings(sessionToken, controller.signal).catch(() => undefined);
      }
    };
    const resume = () => {
      if (document.visibilityState !== "visible" || !current()) return;
      // Refresh before showing cached source text again after a hidden window.
      useNotificationStore.getState().mirrorContext(userId, [], false);
      void queryClient.invalidateQueries({ queryKey });
      synchronize();
    };
    synchronize();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      controller.abort();
      if (activeInbox?.current === current) activeInbox = null;
      useNotificationStore.getState().setContextUser(null);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [userId, knownUserId, sessionToken, queryClient, queryKey]);

  useEffect(() => {
    if (userId && inbox.data && !inbox.isFetching) {
      useNotificationStore.getState().mirrorContext(userId, inbox.data.items, inbox.data.can_display);
    }
  }, [inbox.data, inbox.dataUpdatedAt, inbox.isFetching, userId]);

  return null;
}
