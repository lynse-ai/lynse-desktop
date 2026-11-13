"use client";

/**
 * "我的反馈" pane of the suggestion center: the caller's own FeedLog posts,
 * scoped to this device's guest session (or a future SSO session). Clicking
 * a row opens the post's public permalink, where replies and status changes
 * are visible; statuses come from the FeedLog board workflow.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@lynse/ui/components/ui/button";
import { Badge } from "@lynse/ui/components/ui/badge";
import { ThumbsUp } from "lucide-react";
import { useTranslation } from "@lynse/core/i18n/react";
import { FEEDLOG_BASE_URL, feedlogPostUrl, listFeedlogMyPosts, type FeedlogPostSummary } from "@lynse/core/api";
import { getDesktopDiagnosticsApi } from "../diagnostics";
import { getStoredFeedlogGuestToken } from "./guest-token";

export function MySuggestionsPane(props: { onNewSuggestion?: () => void }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<FeedlogPostSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const transport = getDesktopDiagnosticsApi()?.feedlogRequest;
    const token = getStoredFeedlogGuestToken();
    if (!transport || !token) {
      // Nothing filed from this device yet (or no transport) — render the
      // empty state rather than an error.
      setItems([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setItems(await listFeedlogMyPosts(FEEDLOG_BASE_URL, transport, token));
    } catch {
      setError(t("settings.feedback_suggestion_failed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-5 py-10 text-xs text-muted-foreground">
        {t("settings.feedback_loading")}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-5 py-10">
        <p className="text-xs text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          {t("settings.feedback_retry")}
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-5 py-10 text-center">
        <p className="text-sm font-medium">{t("settings.feedback_tickets_empty_title")}</p>
        <p className="text-2xs text-muted-foreground">{t("settings.feedback_tickets_empty_description")}</p>
        {props.onNewSuggestion && (
          <Button variant="outline" size="sm" onClick={props.onNewSuggestion}>
            {t("settings.feedback_new_ticket")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-5 py-4">
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => void load()}>
          {t("settings.feedback_refresh")}
        </Button>
      </div>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
          onClick={() => window.open(feedlogPostUrl(item.slug), "_blank", "noopener")}
        >
          <span className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm font-medium">{item.title}</span>
            <span className="flex shrink-0 items-center gap-1 text-2xs tabular-nums text-muted-foreground">
              <ThumbsUp className="size-3" strokeWidth={1.5} />
              {item.voteCount}
            </span>
          </span>
          <span className="flex items-center justify-between gap-2">
            <PostStatusBadge status={item.status} />
            <span className="text-2xs text-muted-foreground">
              {item.createdAt ? formatDate(item.createdAt) : ""}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function PostStatusBadge(props: { status: string }) {
  const { t } = useTranslation();
  // i18next renders the raw key when a workflow status has no translation,
  // which is the right fallback for unknown statuses too.
  return (
    <Badge variant="secondary" className="text-2xs">
      {t(`settings.feedback_post_status_${props.status}`)}
    </Badge>
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString();
}
