"use client";

/**
 * Note share dialog: live card preview, theme picker (image/PDF), format
 * selector (Markdown / PDF / image) and the save / system-share / copy actions.
 */
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import { Button } from "@lynse/ui/components/ui/button";
import { Checkbox } from "@lynse/ui/components/ui/checkbox";
import { cn } from "@lynse/ui/lib/utils";
import { useTranslation } from "@lynse/core/i18n/react";
import { Copy, Loader2, Share } from "../../icons";
import {
  DEFAULT_SHARE_CARD_THEME_ID,
  SHARE_CARD_THEMES,
  getShareCardTheme,
} from "./card-themes";
import {
  mountShareCardOffscreen,
  ShareCard,
  type ShareCardSection,
} from "./share-card";
import {
  buildNoteMarkdownFile,
  buildShareFileName,
  captureCardPng,
  cardPngToPdfBytes,
  copyImageBytesToClipboard,
  countContentWords,
  saveBytesToDisk,
  shareOrSaveBytes,
  stripMindmapContent,
} from "./share-export";

type ShareFormat = "md" | "pdf" | "image";
type ShareAction = "copy" | "save" | "share";

const FORMAT_KEYS: Record<ShareFormat, string> = {
  md: "share.format_md",
  pdf: "share.format_pdf",
  image: "share.format_image",
};

export function ShareNoteDialog({
  open,
  onOpenChange,
  fileId,
  title,
  createdAt,
  outlineText,
  conclusions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileId: string | null;
  title: string | null;
  createdAt?: string | null;
  outlineText?: string | null;
  conclusions: ShareCardSection[];
}) {
  const { t, i18n } = useTranslation();
  const [themeId, setThemeId] = useState(DEFAULT_SHARE_CARD_THEME_ID);
  const [format, setFormat] = useState<ShareFormat>("image");
  const [busy, setBusy] = useState<ShareAction | null>(null);
  // The backend outline is a mind-map document; cards default to summaries
  // only, with the outline as an opt-in.
  const [includeOutline, setIncludeOutline] = useState(false);
  // Forced branding reads as an ad (sspai roundup takeaway) — signature is a
  // toggle, on by default.
  const [showBrand, setShowBrand] = useState(true);

  const theme = getShareCardTheme(themeId);
  const noteTitle = title?.trim() || "Lynse";
  const dateLabel = useMemo(() => {
    const date = createdAt ? new Date(createdAt) : new Date();
    return Number.isNaN(date.getTime())
      ? dateLabelFallback()
      : date.toLocaleDateString(i18n.language);
  }, [createdAt, i18n.language]);

  const includedOutlineText = includeOutline ? outlineText : null;
  const cardProps = {
    theme,
    title: noteTitle,
    dateLabel,
    outlineLabel: t("vault.section_outline"),
    summaryLabel: t("vault.section_summary"),
    outlineText: includedOutlineText,
    conclusions,
    showBrand,
    wordCountLabel: t("share.word_count", {
      count: countContentWords([
        includedOutlineText ? stripMindmapContent(includedOutlineText) : null,
        ...conclusions.map((section) => stripMindmapContent(section.text)),
      ]),
    }),
  };

  async function captureCard() {
    const { element, unmount } = await mountShareCardOffscreen(cardProps);
    try {
      return await captureCardPng(element);
    } finally {
      unmount();
    }
  }

  async function generate(): Promise<{ bytes: Uint8Array; fileName: string }> {
    if (format === "md") {
      const markdown = buildNoteMarkdownFile(
        { fileId: fileId ?? "", title: noteTitle, createdAt: createdAt ?? null, outlineText, conclusions },
        { outline: t("vault.section_outline"), summary: t("vault.section_summary") },
      );
      if (!markdown) throw new Error("note content is empty");
      return {
        bytes: new TextEncoder().encode(markdown),
        fileName: buildShareFileName(noteTitle, "md"),
      };
    }
    const card = await captureCard();
    if (format === "image") {
      return { bytes: card.bytes, fileName: buildShareFileName(noteTitle, "png") };
    }
    return {
      bytes: await cardPngToPdfBytes(card),
      fileName: buildShareFileName(noteTitle, "pdf"),
    };
  }

  async function run(action: ShareAction) {
    if (busy) return;
    setBusy(action);
    try {
      if (action === "copy") {
        const card = await captureCard();
        await copyImageBytesToClipboard(card.bytes);
        toast.success(t("share.copied"));
        return;
      }
      const { bytes, fileName } = await generate();
      if (action === "save") {
        await saveBytesToDisk(bytes, fileName);
        toast.success(t("share.saved"));
      } else {
        const outcome = await shareOrSaveBytes(bytes, fileName);
        toast.success(t(outcome === "shared" ? "share.shared" : "share.saved"));
      }
    } catch (error) {
      console.error("[share-note] action failed:", error);
      toast.error(t("share.failed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("share.title")}</DialogTitle>
        </DialogHeader>

        <div className="max-h-[48vh] overflow-y-auto rounded-xl bg-muted/40 p-4">
          <div className="mx-auto w-fit overflow-hidden rounded-[20px] shadow-sm">
            <ShareCard {...cardProps} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={includeOutline}
              onCheckedChange={(checked) => setIncludeOutline(checked === true)}
              aria-label={t("share.include_outline")}
            />
            {t("share.include_outline")}
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox
              checked={showBrand}
              onCheckedChange={(checked) => setShowBrand(checked === true)}
              aria-label={t("share.show_brand")}
            />
            {t("share.show_brand")}
          </label>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("share.theme")}</span>
            {SHARE_CARD_THEMES.map((item) => (
              <button
                key={item.id}
                type="button"
                title={t(item.nameKey)}
                aria-label={t(item.nameKey)}
                disabled={format === "md"}
                onClick={() => setThemeId(item.id)}
                className={cn(
                  "size-6 rounded-full border border-border transition-opacity disabled:opacity-30",
                  themeId === item.id && "ring-2 ring-ring ring-offset-2 ring-offset-background",
                )}
                style={{ background: item.swatch }}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("share.format")}</span>
            {(Object.keys(FORMAT_KEYS) as ShareFormat[]).map((item) => (
              <Button
                key={item}
                size="sm"
                variant={format === item ? "default" : "outline"}
                className="h-7 px-3"
                onClick={() => setFormat(item)}
              >
                {t(FORMAT_KEYS[item])}
              </Button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          {format === "image" && (
            <Button variant="outline" disabled={!!busy} onClick={() => void run("copy")}>
              {busy === "copy" ? (
                <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
              ) : (
                <Copy className="size-3.5" strokeWidth={1.5} />
              )}
              {t("share.copy_image")}
            </Button>
          )}
          <Button variant="outline" disabled={!!busy} onClick={() => void run("save")}>
            {busy === "save" ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
            ) : null}
            {t("share.save")}
          </Button>
          <Button disabled={!!busy} onClick={() => void run("share")}>
            {busy === "share" ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.5} />
            ) : (
              <Share className="size-3.5" strokeWidth={1.5} />
            )}
            {t("share.system_share")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function dateLabelFallback(): string {
  return new Date().toLocaleDateString();
}
