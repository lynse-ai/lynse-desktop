"use client";

/**
 * Feature-suggestion form backed by the self-hosted FeedLog board
 * (feedback.lynse.ai) — the in-app face of the 功能建议 channel. Submits a
 * public board post through the native transport; the 匿名提交 checkbox
 * decides whether the Lynse username rides along as a content signature
 * (FeedLog SSO sessions are not wired yet, so "identified" means a signed
 * guest post until the lynclaw token-minting endpoint ships).
 */

import { useState } from "react";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { Label } from "@lynse/ui/components/ui/label";
import { Textarea } from "@lynse/ui/components/ui/textarea";
import { Checkbox } from "@lynse/ui/components/ui/checkbox";
import { NativeSelect } from "@lynse/ui/components/ui/native-select";
import { useTranslation } from "@lynse/core/i18n/react";
import { useAuthStore } from "@lynse/core/auth";
import {
  api,
  createFeedlogPost,
  FEEDLOG_BASE_URL,
  FEEDLOG_FEATURE_BOARD_HINT,
  listFeedlogBoards,
  mintFeedlogGuestToken,
  type FeedlogTransport,
} from "@lynse/core/api";
import { getAppInfoSync } from "../app-update";
import { getDesktopDiagnosticsApi } from "../diagnostics";
import { ensureFeedlogGuestToken, storeFeedlogGuestToken } from "./guest-token";

/** Feature area of the suggestion, prepended into the post for triage. */
const SUGGESTION_MODULES: string[] = [
  "recording",
  "knowledge",
  "assistant",
  "live_translation",
  "todo_calendar",
  "account_sync",
  "stability",
  "ui",
  "other",
];

export function FeatureSuggestionForm(props: { onSubmitted?: () => void }) {
  const { t } = useTranslation();
  // Read once per mount: the dialog remounts the form per open, so a
  // login/logout between opens is reflected here.
  const sessionToken = api().getToken();
  const user = useAuthStore((s) => s.user);
  const appInfo = getAppInfoSync();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [module_, setModule] = useState<string>("other");
  // Anonymous by default only when signed out (the checkbox is hidden there —
  // a guest post carries no identity anyway). Signed-in users post under
  // their name unless they opt out.
  const [anonymous, setAnonymous] = useState(!sessionToken);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const transport: FeedlogTransport | null = getDesktopDiagnosticsApi()?.feedlogRequest ?? null;

  function composeContent(): string {
    const meta: string[] = [];
    if (module_ && module_ !== "other") {
      meta.push(`${t("settings.feedback_module_label")}: ${t(`settings.feedback_module_${module_}`)}`);
    }
    if (appInfo) {
      meta.push(`Lynse ${appInfo.version} · ${appInfo.platform}`);
    }
    if (!anonymous && user?.name) {
      meta.push(`${t("settings.feedback_identity_label")} ${user.name}`);
    }
    return meta.length > 0
      ? `${description.trim()}\n\n---\n${meta.join("\n")}`
      : description.trim();
  }

  function pickFeatureBoardId(boards: { id: string; name: string }[]): string | null {
    const feature = boards.find((board) => FEEDLOG_FEATURE_BOARD_HINT.test(board.name));
    return feature?.id ?? boards[0]?.id ?? null;
  }

  async function submit(): Promise<void> {
    if (submitting) return;
    if (!title.trim() || !description.trim()) {
      setSubmitError(t("settings.feedback_suggestion_required"));
      return;
    }
    if (!transport) {
      setSubmitError(t("settings.feedback_suggestion_unavailable"));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const token = await ensureFeedlogGuestToken(FEEDLOG_BASE_URL, transport);
      if (!token) throw new Error(t("settings.feedback_suggestion_failed"));
      const boardId = pickFeatureBoardId(await listFeedlogBoards(FEEDLOG_BASE_URL, transport));
      const content = composeContent();
      let result = await createFeedlogPost(FEEDLOG_BASE_URL, transport, token, {
        title: title.trim(),
        content,
        boardId,
      });
      if (result.status === 401) {
        // Cached guest session expired server-side — mint a fresh one once.
        const fresh = await mintFeedlogGuestToken(FEEDLOG_BASE_URL, transport);
        if (fresh) {
          storeFeedlogGuestToken(fresh);
          result = await createFeedlogPost(FEEDLOG_BASE_URL, transport, fresh, {
            title: title.trim(),
            content,
            boardId,
          });
        }
      }
      if (result.status === 403) {
        throw new Error(t("settings.feedback_suggestion_guest_off"));
      }
      if (result.status !== 201 || !result.post) {
        throw new Error(t("settings.feedback_suggestion_failed"));
      }
      // Reset for the next suggestion, then hand over to the list tab where
      // the new post appears at the top.
      setTitle("");
      setDescription("");
      props.onSubmitted?.();
    } catch (error) {
      setSubmitError(error instanceof Error && error.message ? error.message : t("settings.feedback_suggestion_failed"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 py-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="suggestion-title">{t("settings.feedback_suggestion_title_label")}</Label>
        <Input
          id="suggestion-title"
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("settings.feedback_suggestion_title_placeholder")}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="suggestion-description">{t("settings.feedback_suggestion_desc_label")}</Label>
        <Textarea
          id="suggestion-description"
          value={description}
          maxLength={10000}
          rows={8}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t("settings.feedback_suggestion_desc_placeholder")}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="suggestion-module">{t("settings.feedback_module_label")}</Label>
        <NativeSelect
          id="suggestion-module"
          value={module_}
          onChange={(event) => setModule(event.target.value)}
          className="w-full"
        >
          {SUGGESTION_MODULES.map((key) => (
            <option key={key} value={key}>
              {t(`settings.feedback_module_${key}`)}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1">
        {sessionToken ? (
          <>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={anonymous} onCheckedChange={(checked) => setAnonymous(checked === true)} />
              <span>{t("settings.feedback_anonymous")}</span>
            </label>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              {anonymous
                ? t("settings.feedback_anonymous_hint")
                : t("settings.feedback_identity_hint", { name: user?.name ?? "" })}
            </p>
          </>
        ) : (
          <p className="text-2xs leading-relaxed text-muted-foreground">
            {t("settings.feedback_anonymous_signed_out")}
          </p>
        )}
      </div>
      {submitError && <p className="text-xs text-destructive">{submitError}</p>}
      <div className="flex justify-end">
        <Button onClick={submit} disabled={submitting || !transport}>
          {submitting ? t("settings.report_submitting") : t("settings.feedback_suggestion_submit")}
        </Button>
      </div>
    </div>
  );
}
