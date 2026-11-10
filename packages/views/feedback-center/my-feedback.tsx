"use client";

/**
 * 「我的反馈」tab: ticket list → detail with a staff/user timeline, mirroring
 * ZCode's feedback center (list grouped by day, detail adds supplements).
 * Status values come from the Feishu ticket store in Chinese already; the
 * lookup table maps each to its i18n key and tone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@lynse/ui/components/ui/button";
import { Textarea } from "@lynse/ui/components/ui/textarea";
import { Badge } from "@lynse/ui/components/ui/badge";
import { cn } from "@lynse/ui/lib/utils";
import { useTranslation } from "@lynse/core/i18n/react";
import { api } from "@lynse/core/api";
import { addFeedbackMessage, getFeedbackTicket, listFeedbackTickets, type FeedbackTicketDetail, type FeedbackTicketSummary } from "@lynse/core/api";
import { ArrowLeft, Check, Clock, Loader2, RefreshCw, Send } from "../icons";

type ResolvedStatus = { key: string; tone: "neutral" | "progress" | "success" | "rejected" };

/** Feishu status values → i18n key + chip tone (unknown values stay neutral). */
function resolveStatus(status: string): ResolvedStatus {
  switch (status) {
    case "已提交":
      return { key: "settings.feedback_status_submitted", tone: "neutral" };
    case "信息不足":
      return { key: "settings.feedback_status_need_info", tone: "neutral" };
    case "已采纳":
    case "开发中":
    case "处理中":
      return { key: "settings.feedback_status_in_progress", tone: "progress" };
    case "已解决":
    case "已上线":
      return { key: "settings.feedback_status_resolved", tone: "success" };
    case "已拒绝":
    case "答复关闭":
    case "已归档":
      return { key: "settings.feedback_status_rejected", tone: "rejected" };
    default:
      return { key: "settings.feedback_status_submitted", tone: "neutral" };
  }
}

function formatTime(ms: number | null, locale: string): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusChip({ status }: { status: string }) {
  const { t } = useTranslation();
  const resolved = resolveStatus(status);
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0 text-2xs font-normal",
        resolved.tone === "progress" && "border-warning/40 bg-warning/10 text-warning",
        resolved.tone === "success" && "border-success/40 bg-success/10 text-success",
        resolved.tone === "rejected" && "border-muted-foreground/30 bg-muted/40 text-muted-foreground",
      )}
    >
      {t(resolved.key)}
    </Badge>
  );
}

/** Day grouping like ZCode's feedback list (today / earlier). */
function groupLabel(createdAt: number | null): "today" | "earlier" | null {
  if (!createdAt) return null;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return createdAt >= startOfToday ? "today" : "earlier";
}

function FeedbackList({
  tickets,
  loading,
  onRefresh,
  onOpen,
}: {
  tickets: FeedbackTicketSummary[];
  loading: boolean;
  onRefresh: () => void;
  onOpen: (ticketId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const groups = useMemo(() => {
    const today: FeedbackTicketSummary[] = [];
    const earlier: FeedbackTicketSummary[] = [];
    for (const ticket of tickets) {
      (groupLabel(ticket.created_at) === "today" ? today : earlier).push(ticket);
    }
    return [
      { key: "settings.feedback_group_today", items: today },
      { key: "settings.feedback_group_earlier", items: earlier },
    ].filter((group) => group.items.length > 0);
  }, [tickets]);

  if (loading && tickets.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (tickets.length === 0) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-1.5 px-6 text-center">
        <p className="text-sm font-medium">{t("settings.feedback_tickets_empty_title")}</p>
        <p className="max-w-xs text-2xs leading-relaxed text-muted-foreground text-pretty">
          {t("settings.feedback_tickets_empty_description")}
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <div className="flex justify-end px-3 pt-1">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 text-2xs text-muted-foreground"
          onClick={onRefresh}
          disabled={loading}
        >
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          {t("settings.feedback_refresh")}
        </Button>
      </div>
      {groups.map((group) => (
        <div key={group.key} className="px-1">
          <p className="px-3 py-1.5 text-2xs font-medium text-muted-foreground">{t(group.key)}</p>
          {group.items.map((ticket) => (
            <button
              key={ticket.ticket_id}
              type="button"
              onClick={() => onOpen(ticket.ticket_id)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{ticket.title || t("settings.feedback_untitled")}</p>
                <p className="mt-0.5 text-2xs text-muted-foreground">
                  {formatTime(ticket.created_at, i18n.language)}
                </p>
              </div>
              <StatusChip status={ticket.status} />
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function FeedbackDetail({
  ticketId,
  onBack,
}: {
  ticketId: string;
  onBack: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [detail, setDetail] = useState<FeedbackTicketDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [supplement, setSupplement] = useState("");
  const [sending, setSending] = useState(false);
  const sessionToken = api().getToken();
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const token = api().getToken();
    if (!token) {
      setLoadError(t("settings.feedback_login_required"));
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await getFeedbackTicket(ticketId, token);
      setDetail(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(String(error).slice(0, 200));
    } finally {
      setLoading(false);
    }
  }, [ticketId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    // jsdom has no scrollIntoView; the optional call keeps tests honest.
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [detail?.messages.length]);

  async function sendSupplement() {
    const token = api().getToken();
    const content = supplement.trim();
    if (!token || !content || sending || !detail) return;
    setSending(true);
    try {
      const message = await addFeedbackMessage(detail.ticket.ticket_id, content, token);
      setDetail({ ...detail, messages: [...detail.messages, message] });
      setSupplement("");
    } catch (error) {
      setLoadError(String(error).slice(0, 200));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" />
          {t("settings.feedback_back_to_list")}
        </Button>
        {detail && <StatusChip status={detail.ticket.status} />}
      </div>

      {loading && !detail ? (
        <div className="flex min-h-40 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : loadError && !detail ? (
        <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-6 text-center">
          <p className="text-2xs leading-relaxed text-destructive text-pretty">{loadError}</p>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void load()}>
            {t("settings.feedback_retry")}
          </Button>
        </div>
      ) : detail ? (
        <>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            <div>
              <h3 className="text-sm font-semibold leading-snug text-pretty">{detail.ticket.title}</h3>
              <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground text-pretty">
                {detail.ticket.description}
              </p>
              {detail.ticket.screenshot_url && (
                <a
                  href={detail.ticket.screenshot_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-2xs text-primary underline-offset-2 hover:underline"
                >
                  {t("settings.feedback_view_screenshot")}
                </a>
              )}
            </div>

            <div className="space-y-2">
              {detail.messages.map((message) => {
                const staff = message.sender === "staff";
                return (
                  <div
                    key={message.message_id}
                    className={cn(
                      "rounded-lg border px-3 py-2",
                      staff ? "border-primary/25 bg-primary/5" : "bg-muted/30",
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-2xs font-medium">
                      {staff ? (
                        <Check className="size-3 text-primary" />
                      ) : (
                        <Clock className="size-3 text-muted-foreground" />
                      )}
                      <span className={staff ? "text-primary" : "text-muted-foreground"}>
                        {staff
                          ? t("settings.feedback_timeline_staff_replied")
                          : t("settings.feedback_timeline_user_replied")}
                      </span>
                      <span className="ml-auto font-normal text-muted-foreground">
                        {formatTime(message.created_at, i18n.language)}
                      </span>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-pretty">
                      {message.content}
                    </p>
                  </div>
                );
              })}
              {detail.messages.length === 0 && (
                <p className="text-2xs leading-relaxed text-muted-foreground">
                  {t("settings.feedback_timeline_empty")}
                </p>
              )}
              <div ref={bottomRef} />
            </div>
          </div>

          <div className="border-t px-4 py-3">
            {sessionToken ? (
              <div className="space-y-2">
                <Textarea
                  value={supplement}
                  onChange={(event) => setSupplement(event.target.value)}
                  placeholder={t("settings.feedback_supplement_placeholder")}
                  className="min-h-16 text-sm"
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    disabled={!supplement.trim() || sending}
                    onClick={() => void sendSupplement()}
                  >
                    {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                    {t("settings.feedback_supplement_send")}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-2xs text-muted-foreground">{t("settings.feedback_login_required")}</p>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function MyFeedbackPane({
  onNewTicket,
}: {
  /** Bottom action: jump back to the submit tab with a fresh form. */
  onNewTicket: () => void;
}) {
  const { t } = useTranslation();
  const [tickets, setTickets] = useState<FeedbackTicketSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const token = api().getToken();
    if (!token) {
      setTickets([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await listFeedbackTickets(token);
      setTickets(result.items);
    } catch {
      setTickets([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (selectedId) {
    return <FeedbackDetail ticketId={selectedId} onBack={() => { setSelectedId(null); void load(); }} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FeedbackList
        tickets={tickets}
        loading={loading}
        onRefresh={() => void load()}
        onOpen={setSelectedId}
      />
      <div className="border-t px-5 py-3">
        <Button
          size="sm"
          variant="outline"
          className="h-7 w-full text-xs"
          onClick={onNewTicket}
        >
          {t("settings.feedback_new_ticket")}
        </Button>
      </div>
    </div>
  );
}
