"use client";

/**
 * Minimal "paste a link" entry — collect WeChat / Xiaohongshu / Weibo posts
 * seen around the web to read later. Saving stores the URL as a record in
 * the Records (记录) board tagged with the reserved LINK_RECORD_TAG, which
 * marks it for the future AI-analysis pipeline; no fetching, no cloud.
 */

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";
import { useTranslation } from "@lynse/core/i18n/react";
import { useQueryClient } from "@tanstack/react-query";
import { getDesktopInspirationApi, LINK_RECORD_TAG } from "../inspiration";

function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

export function PasteLinkDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);

  // Prefill from the clipboard so "copy link → save" is one step; silently
  // skip when clipboard read is unavailable or denied.
  useEffect(() => {
    if (!open) return;
    setUrl("");
    void navigator.clipboard
      ?.readText()
      .then((text) => {
        if (isHttpUrl(text)) setUrl(text.trim());
      })
      .catch(() => {});
  }, [open]);

  const handleSave = async () => {
    const trimmed = url.trim();
    if (!isHttpUrl(trimmed)) {
      toast.error(t("home.paste_link_invalid"));
      return;
    }
    const api = getDesktopInspirationApi();
    if (!api) {
      toast.error(t("home.paste_link_unavailable"));
      return;
    }
    setSaving(true);
    try {
      // The inline tag is the visible marker in the record text; the tags
      // array is what the AI-analysis pipeline will filter on.
      await api.save({ text: `${trimmed} #${LINK_RECORD_TAG}`, tags: [LINK_RECORD_TAG] });
      void queryClient.invalidateQueries({ queryKey: ["inspirations"] });
      toast.success(t("home.paste_link_saved"));
      onOpenChange(false);
    } catch (error) {
      toast.error(t("inspiration.toast_save_failed"), { description: String(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{t("home.paste_link_title")}</DialogTitle>
          <DialogDescription>{t("home.paste_link_description")}</DialogDescription>
        </DialogHeader>
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder={t("home.paste_link_placeholder")}
          autoFocus
          onKeyDown={(event) => {
            if (event.key === "Enter" && !saving) {
              event.preventDefault();
              void handleSave();
            }
          }}
        />
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("home.paste_link_cancel")}
          </Button>
          <Button type="button" disabled={saving} onClick={() => void handleSave()}>
            {t("home.paste_link_save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
