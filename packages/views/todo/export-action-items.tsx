"use client";

import { useMemo, useState } from "react";
import { Button } from "@lynse/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lynse/ui/components/ui/select";
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import {
  isNoDestinationError,
  type IntegrationsProvider,
} from "@lynse/core/integrations";
import { Loader2 } from "../icons";
import { useDestinations, useExportActionItems } from "../connections/use-connections";

/**
 * Action-item export (PRD FR-2).
 *
 * Selection is page-local rather than in `TodoStore`: it is transient view
 * state with exactly one consumer, and the store already carries the
 * single-select detail-sheet id (`page.tsx:537`) — a second "selected" concept
 * there would be ambiguous.
 *
 * Only cloud todos are exportable: the export contract keys items by their
 * cloud id, and local todos (`TodoItem.backend`, `todo-api.ts:44`) have none.
 * Callers must filter before handing ids over, and the row renders those items
 * as non-selectable.
 */

export const EXPORTABLE_PROVIDERS: IntegrationsProvider[] = ["todoist", "google-tasks", "feishu-tasks"];

export function useTodoExportSelection(todos: { id: string; backend?: boolean }[]) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const exportable = useMemo(
    () => new Set(todos.filter((todo) => todo.backend).map((todo) => todo.id)),
    [todos],
  );

  return {
    selected,
    exportableIds: exportable,
    count: selected.size,
    toggle: (id: string) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    selectAll: () => setSelected(new Set(exportable)),
    clear: () => setSelected(new Set()),
  };
}

export function TodoExportBar({
  count,
  onSelectAll,
  onClear,
  onExport,
}: {
  count: number;
  onSelectAll: () => void;
  onClear: () => void;
  onExport: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-border/50 bg-muted/30 px-6 py-1.5">
      <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-2xs" onClick={onSelectAll}>
        {t("todo.export_select_all")}
      </Button>
      <span className="text-2xs tabular-nums text-muted-foreground">
        {t("todo.export_selected", { count })}
      </span>
      <div className="flex-1" />
      <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-2xs" onClick={onClear}>
        {t("todo.export_cancel")}
      </Button>
      <Button type="button" size="sm" className="h-6 text-2xs" disabled={count === 0} onClick={onExport}>
        {t("todo.export_button")}
      </Button>
    </div>
  );
}

/**
 * Pick provider + destination, then export. A missing destination is not a
 * dead end: the backend answers 409 `no_destination`, which we surface as a
 * hint to choose one rather than as a generic failure.
 */
export function TodoExportDialog({
  open,
  onOpenChange,
  actionItemIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actionItemIds: string[];
}) {
  const { t } = useTranslation();
  const [provider, setProvider] = useState<IntegrationsProvider>("todoist");
  const [destinationId, setDestinationId] = useState<string>("");
  const destinations = useDestinations(provider, open);
  const exporter = useExportActionItems(provider);

  const submit = () => {
    const field = provider === "todoist" ? "default_project_id" : "default_task_list_id";
    exporter.mutate(
      { action_item_ids: actionItemIds, [field]: destinationId || undefined } as never,
      {
        onSuccess: (result) => {
          onOpenChange(false);
          setDestinationId("");
          if (result.failed.length === 0) {
            toast.success(
              t("todo.export_success", {
                count: result.succeeded.length,
                provider: t(`connections.provider.${provider}`),
              }),
            );
          } else {
            toast.warning(
              t("todo.export_partial", {
                succeeded: result.succeeded.length,
                failed: result.failed.length,
              }),
            );
          }
        },
        onError: (error) => {
          toast.error(
            isNoDestinationError(error)
              ? t("connections.pick_a_destination_first")
              : t("connections.error.generic", {
                  error: error instanceof Error ? error.message : String(error),
                }),
          );
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-sm">{t("todo.export_title")}</DialogTitle>
          <DialogDescription className="text-2xs">
            {t("todo.export_subtitle", { count: actionItemIds.length })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-2xs text-muted-foreground">{t("todo.export_choose_provider")}</p>
            <Select
              value={provider}
              onValueChange={(value) => {
                setProvider(value as IntegrationsProvider);
                setDestinationId("");
              }}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPORTABLE_PROVIDERS.map((candidate) => (
                  <SelectItem key={candidate} value={candidate}>
                    {t(`connections.provider.${candidate}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <p className="text-2xs text-muted-foreground">{t("todo.export_choose_destination")}</p>
            <Select value={destinationId} onValueChange={(value) => setDestinationId(String(value))}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue
                  placeholder={
                    destinations.isFetching
                      ? t("todo.export_loading_destinations")
                      : (destinations.data?.destinations.length
                          ? t("connections.no_destination")
                          : t("todo.export_no_destinations"))
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {(destinations.data?.destinations ?? []).map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("todo.export_dialog_cancel")}
          </Button>
          <Button type="button" size="sm" disabled={exporter.isPending} onClick={submit}>
            {exporter.isPending && <Loader2 className="size-3.5 animate-spin" />}
            {t("todo.export_button")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
