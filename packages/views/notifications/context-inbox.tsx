"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getAuthStore, useAuthStore } from "@lynse/core/auth";
import { api } from "@lynse/core/api/client";
import { ApiError } from "@lynse/core/api";
import { actOnContextInbox, getContextInboxItem, listContextInbox, syncContextMeetings } from "@lynse/core/api";
import type { ContextInboxAction, ContextInboxItem, ContextInboxResult } from "@lynse/core/api";
import { useTranslation } from "@lynse/core/i18n/react";
import { useChatStore } from "../workspace/hooks/use-chat-store";
import { useNotificationStore, type NotificationItem } from "./use-notification-store";
import { useContextInboxEnabled } from "./context-inbox-preferences";

interface InboxController {
  userId: string;
  current: () => boolean;
  action: (item: ContextInboxItem, action: ContextInboxAction) => Promise<void>;
  open: (item: ContextInboxItem, push: (path: string) => void) => Promise<void>;
}

let activeInbox: InboxController | null = null;

/**
 * Account switches and unmounts abort an in-flight open on purpose; recovery
 * is the refreshed inbox list, not an error toast.
 */
export function isBenignContextOpenError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "AbortError"
    || (error instanceof ApiError && error.status === 401);
}

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

/** Account isolation remains active even while suggestions are disabled. */
export function ContextInboxNotifier() {
  const authenticated = useAuthStore((s) => s.isAuthenticated);
  const userId = useAuthStore((s) => s.user?.id || null);
  const enabled = useContextInboxEnabled(authenticated ? userId : null);
  const identityRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const identity = `${authenticated ? "signed-in" : "signed-out"}:${userId ?? "pending"}`;
    if (identityRef.current !== identity) {
      identityRef.current = identity;
      useChatStore.getState().switchUser(null);
    }
  }, [authenticated, userId]);
  return enabled ? <EnabledContextInboxNotifier /> : null;
}

/** Unmounting cancels inbox/sync requests, removes cached results and stops polling. */
function EnabledContextInboxNotifier() {
  const authenticated = useAuthStore((s) => s.isAuthenticated);
  const knownUserId = useAuthStore((s) => s.user?.id ?? null);
  const { t } = useTranslation();
  const sessionToken = authenticated ? api().getToken() : null;
  const queryClient = useQueryClient();
  // `open` runs from effects after mount, so it reads the live translation
  // through a ref instead of capturing the first render's `t`.
  const tRef = useRef(t);
  useLayoutEffect(() => {
    tRef.current = t;
  }, [t]);
  // Consecutive inbox failures drive the poll backoff; counted here because
  // TanStack's fetchFailureCount stays flat when retry is disabled.
  const consecutiveFailures = useRef(0);
  // Query keys contain a disposable session ID, never the login credential.
  const sessionId = useMemo(() => authenticated && sessionToken
    ? `${knownUserId ?? "verified-by-server"}:${crypto.randomUUID()}` : "signed-out", [authenticated, knownUserId, sessionToken]);
  const queryKey = useMemo(() => ["context-inbox", sessionId], [sessionId]);
  const inbox = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      try {
        const data = await listContextInbox(sessionToken!, signal);
        consecutiveFailures.current = 0;
        return data;
      } catch (error) {
        // Cancellation is not an endpoint failure; never let it back off the poll.
        if ((error as { name?: string })?.name !== "AbortError") consecutiveFailures.current += 1;
        throw error;
      }
    },
    enabled: !!sessionToken,
    staleTime: 0,
    retry: false,
    // A closed server gate is terminal: stop the timer entirely (a window
    // focus still re-checks once, so a later enable is discovered). Otherwise
    // back off when the inbox keeps failing (server off) so the poll stops
    // hammering a closed endpoint every minute.
    refetchInterval: (query) => {
      const data = query.state.data as ContextInboxResult | undefined;
      if (data?.available === false) return false;
      return consecutiveFailures.current >= 3 ? 300_000 : 60_000;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  useLayoutEffect(() => {
    const store = useNotificationStore.getState();
    store.setContextUser(null);
    activeInbox = null;
    consecutiveFailures.current = 0;
    return () => {
      activeInbox = null;
      useNotificationStore.getState().setContextUser(null);
      useNotificationStore.getState().setContextUnavailable(false);
      void queryClient.cancelQueries({ queryKey });
      queryClient.removeQueries({ queryKey });
    };
  }, [queryClient, queryKey, authenticated, knownUserId]);

  const userId = sessionToken && inbox.data?.available === true && !inbox.isError
    && (!knownUserId || knownUserId === inbox.data.user_id) ? inbox.data.user_id : null;
  useEffect(() => {
    useNotificationStore.getState().setContextUnavailable(!!sessionToken && inbox.isError);
  }, [inbox.isError, sessionToken]);
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
          if (displayInFlight || !queryClient.getQueryData<ContextInboxResult>(queryKey)?.can_display) return Promise.resolve();
        }
        const operation = operations.get(key) ?? {
          id: crypto.randomUUID(),
          snoozedUntil: action === "snooze" ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : undefined,
        };
        operations.set(key, operation);
        const run = (async () => {
          const result = await actOnContextInbox(item, action, sessionToken, operation.id, operation.snoozedUntil, controller.signal);
          if (!current()) return;
          queryClient.setQueryData<ContextInboxResult>(queryKey, (old) => old && old.available === true ? {
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
        chat.sendMessage(tRef.current("notifications.context_open_prompt", { itemId: item.item_id }), undefined, false, undefined, { assistant: "lynse" });
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
    if (userId && inbox.data?.available === true && !inbox.isFetching) {
      useNotificationStore.getState().mirrorContext(userId, inbox.data.items, inbox.data.can_display);
    }
  }, [inbox.data, inbox.dataUpdatedAt, inbox.isFetching, userId]);

  return null;
}
