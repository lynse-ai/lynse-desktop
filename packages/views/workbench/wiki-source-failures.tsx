"use client";

import { lazy, Suspense, useState } from "react";
import { useTranslation } from "@lynse/core/i18n/react";
import { Button } from "@lynse/ui/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@lynse/ui/components/ui/dialog";
import { useNavigation } from "../navigation";
import { catalogIssueLocation, citationIssueLocation, wikiFailureResolution } from "./errors";
import { GraphSourceNote } from "./graph-source-note";
import { WikiFailureReport } from "./wiki-failure-report";
import type { SourceRef } from "./types";
import type { useWiki } from "./wiki";

const SettingsDialog = lazy(() => import("../settings/settings-dialog").then(module => ({ default: module.SettingsDialog })));

export function WikiSourceFailures({ wiki }: { wiki: ReturnType<typeof useWiki> }) {
  const { t, i18n } = useTranslation();
  const navigation = useNavigation();
  const [source, setSource] = useState<SourceRef | null>(null);
  const [settings, setSettings] = useState<"account" | "ai_assistant" | null>(null);
  const [actionError, setActionError] = useState("");
  const failures = wiki.data?.sourceFailures ?? [];
  const retrying = failures.some(failure => failure.retrying);
  if (!failures.length) return null;
  return <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t("workbench.wiki_source_attention")}>
    <h2 className="text-base font-semibold">{t("workbench.wiki_source_attention")}</h2>
    <p className="text-sm text-muted-foreground">{t("workbench.wiki_source_preserved")}</p>
    {wiki.status?.allowAi === false && <><p role="status" className="text-sm text-muted-foreground">{t("workbench.wiki_source_paused")}</p><Button size="sm" variant="outline" onClick={() => navigation.push("/memory?tab=settings")}>{t("workbench.auto_settings")}</Button></>}
    <Button size="sm" disabled={wiki.busy || wiki.status?.phase === "processing" || !wiki.status?.allowAi} onClick={() => {
      setActionError("");
      void wiki.mutate({ action: "retry" }).catch(() => setActionError(t("workbench.wiki_failure_action_failed")));
    }}>{t(retrying && wiki.status?.phase === "processing" ? "workbench.wiki_source_retrying" : "workbench.wiki_source_retry")}</Button>
    {retrying && <p role="status" className="text-sm text-muted-foreground">{t("workbench.wiki_source_retrying_help")}</p>}
    {actionError && <p role="alert" className="text-sm text-destructive">{actionError}</p>}
    {failures.map(failure => {
      const resolution = wikiFailureResolution(failure.message, failure.validation);
      const position = citationIssueLocation(failure.validation?.citationIssue) ?? catalogIssueLocation(failure.validation?.catalogIssue);
      const entry = wiki.status?.entries.find(entry => entry.id === failure.sourceId);
      const date = new Date(failure.occurredAt);
      return <details key={failure.id} className="min-w-0 border-t border-border pt-3">
        <summary className="cursor-pointer break-words text-sm font-medium">{failure.title || t("workbench.wiki_source_run")} — {t(failure.retrying ? "workbench.wiki_source_retrying" : resolution.reason)}</summary>
        <div className="mt-3 space-y-3 text-sm">
          <p>{t(resolution.citation && !resolution.catalog ? "workbench.wiki_source_citation_help" : resolution.advice)}</p>
          {!failure.retrying && (resolution.catalog || resolution.citation) && <WikiFailureReport {...failure} />}
          {resolution.catalog && !failure.validation?.catalogIssue && <p className="text-muted-foreground">{t("workbench.wiki_catalog_unknown")}</p>}
          {failure.validation?.correctionAttempted && <p className="text-muted-foreground">{t("workbench.wiki_failure_correction_attempted")}</p>}
          <details><summary className="cursor-pointer text-xs font-medium">{t("workbench.wiki_failure_details")}</summary><dl className="mt-2 space-y-2 text-xs">
            {position && <div><dt className="text-muted-foreground">{t("workbench.wiki_citation_location")}</dt><dd>{t(position.key, position.values)}</dd></div>}
            {failure.validation?.catalogIssue && <div><dt className="text-muted-foreground">{t("workbench.wiki_catalog_code")}</dt><dd className="font-mono">{failure.validation.catalogIssue.code}{failure.validation.catalogIssue.field ? ` · ${failure.validation.catalogIssue.field}` : ""}</dd></div>}
            <div><dt className="text-muted-foreground">{t("workbench.wiki_failure_stage")}</dt><dd>{t(failure.stage === "preparing" ? "workbench.home_preparing" : "workbench.home_analyzing")}</dd></div>
            {!Number.isNaN(date.getTime()) && <div><dt className="text-muted-foreground">{t("workbench.wiki_failure_time")}</dt><dd><time dateTime={failure.occurredAt}>{date.toLocaleString(i18n.language)}</time></dd></div>}
            <div><dt className="text-muted-foreground">{t("workbench.wiki_failure_technical")}</dt><dd className="whitespace-pre-wrap break-all font-mono">{failure.message}</dd></div>
          </dl></details>
          <div className="flex flex-wrap gap-2">
            {entry && <Button size="sm" variant="outline" onClick={() => setSource({ id: entry.id, kind: entry.kind, revision: entry.revision, quote: "" })}>{t("workbench.wiki_failure_open_source", { title: entry.title })}</Button>}
            {resolution.settings && <Button size="sm" variant="outline" onClick={() => (resolution.settings === "scope" || resolution.settings === "connection") ? navigation.push("/memory?tab=settings") : setSettings(resolution.settings === "account" ? "account" : "ai_assistant")}>{t(resolution.settings === "connection" ? "workbench.wiki_failure_connection_settings" : resolution.settings === "scope" ? "workbench.auto_settings" : resolution.settings === "account" ? "workbench.wiki_failure_account" : "workbench.wiki_failure_model")}</Button>}
          </div>
        </div>
      </details>;
    })}
    <Dialog open={!!source} onOpenChange={open => { if (!open) setSource(null); }}><DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{t("workbench.auto_source_meetings")}</DialogTitle><DialogDescription>{t("workbench.auto_source_hint")}</DialogDescription></DialogHeader>{source && <GraphSourceNote key={source.id} source={source} />}</DialogContent></Dialog>
    {settings && <Suspense fallback={null}><SettingsDialog open onOpenChange={open => { if (!open) setSettings(null); }} initialSectionId={settings} /></Suspense>}
  </section>;
}
