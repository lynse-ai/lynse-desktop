"use client";

import { useState, useCallback, useMemo } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@lynse/ui/components/ui/dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { useTranslation } from "@lynse/core/i18n/react";
import { Loader2 } from "../icons";
import { useTemplateCategories, useResummarize } from "./hooks/use-files";
import { useQueryClient } from "@tanstack/react-query";
import { TemplateSelector } from "./template-selector";

interface ResummarizeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileId: string | null;
}

export function ResummarizeDialog({ open, onOpenChange, fileId }: ResummarizeDialogProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data: categories } = useTemplateCategories();
  const resummarize = useResummarize();

  const [selectedId, setSelectedId] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState(false);

  // Flat list + default template
  const allTemplates = useMemo(() => {
    if (!categories) return [];
    return categories.flatMap((c) => c.templates);
  }, [categories]);

  const defaultTemplate = useMemo(() => {
    return allTemplates.find((tpl) => tpl.isDefault === 1) ?? allTemplates[0];
  }, [allTemplates]);

  const effectiveId = selectedId || defaultTemplate?.id || "";

  const handleApply = useCallback(async () => {
    if (!fileId || !effectiveId) return;
    setIsProcessing(true);
    try {
      await resummarize.mutateAsync({
        aiTaskType: "conclusion",
        fileId,
        templateId: effectiveId,
      });
      toast.success(t("resummarize.success"));
      qc.invalidateQueries({ queryKey: ["file-conclusions", fileId] });
      onOpenChange(false);
      setSelectedId("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("resummarize.unknown_error");
      toast.error(t("resummarize.failed"), { description: msg });
    } finally {
      setIsProcessing(false);
    }
  }, [fileId, effectiveId, resummarize, qc, t, onOpenChange]);

  const handleClose = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && isProcessing) return;
      if (!nextOpen) setSelectedId("");
      onOpenChange(nextOpen);
    },
    [isProcessing, onOpenChange],
  );

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("resummarize.title")}</DialogTitle>
          <DialogDescription>
            {t("resummarize.description")}
          </DialogDescription>
        </DialogHeader>

        {/* Template list */}
        <TemplateSelector
          categories={categories ?? []}
          selectedId={effectiveId}
          onSelect={setSelectedId}
          scrollHeight="h-72"
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)} disabled={isProcessing}>
            {t("resummarize.cancel")}
          </Button>
          <Button onClick={handleApply} disabled={!effectiveId || isProcessing}>
            {isProcessing ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : null}
            {t("resummarize.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

