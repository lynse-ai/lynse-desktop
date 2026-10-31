/**
 * Generation + delivery logic for the note share feature: markdown assembly,
 * card PNG/PDF rendering and the save / system-share bridges. UI lives in
 * share-note-dialog.tsx; this module is deliberately DOM-light so the pure
 * parts (file names, PDF pagination) stay unit-testable.
 */
import { buildNoteMarkdown } from "../note-vault";
import type { VaultNoteContentInput, VaultSectionLabels } from "../note-vault";

// ---------------------------------------------------------------------------
// Desktop bridge
// ---------------------------------------------------------------------------

export interface DesktopShareApi {
  /**
   * Write the payload to a temp file and open the OS share sheet for it
   * (macOS NSSharingServicePicker). Resolves false when the platform has no
   * native share sheet; rejects on failure. Callers fall back to saving.
   */
  shareFile: (name: string, bytes: Uint8Array) => Promise<boolean>;
}

export function getDesktopShareApi(): DesktopShareApi | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & {
    desktopAPI?: { share?: DesktopShareApi };
  };
  return desktopWindow.desktopAPI?.share ?? null;
}

// ---------------------------------------------------------------------------
// File names
// ---------------------------------------------------------------------------

export function sanitizeFileName(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

export function buildShareFileName(title: string, ext: string, date = new Date()): string {
  const base = sanitizeFileName(title) || "Lynse";
  return `${base}-${date.toISOString().slice(0, 10)}.${ext}`;
}

// ---------------------------------------------------------------------------
// Mind-map stripping
// ---------------------------------------------------------------------------

// Backend templates embed mind maps as images with a custom "mindmap:" URI
// scheme (see summary-editor.tsx). The share card must not carry them: left
// unrepaired they render as broken images showing their alt text (e.g.
// 「思维导图」), repaired they would bloat the card with a huge PNG.
const MINDMAP_MD_IMAGE = /!\[[^\]]*\]\(\s*mindmap:[^)]*\)/gi;
const MINDMAP_HTML_IMG = /<img[^>]+src=(["']?)mindmap:[^"'\s>]*\1[^>]*>/gi;
// Backend markdown introduces the image with its own 「## 思维导图」 heading;
// strip the heading too or the label outlives the image it announced.
const MINDMAP_MD_HEADING = /^[ \t]*#{1,6}[ \t]*思维导图[ \t]*\r?\n?/gm;
const MINDMAP_HTML_HEADING = /<h[1-6][^>]*>\s*思维导图\s*<\/h[1-6]>/gi;

/** Remove mind-map images and their 「思维导图」 headings from markdown or HTML content. */
export function stripMindmapContent(text: string): string {
  return text
    .replace(MINDMAP_MD_IMAGE, "")
    .replace(MINDMAP_HTML_IMG, "")
    .replace(MINDMAP_MD_HEADING, "")
    .replace(MINDMAP_HTML_HEADING, "");
}

// ---------------------------------------------------------------------------
// Word count (card footer stat, flomo-style)
// ---------------------------------------------------------------------------

/**
 * Count "words" across mixed CJK/latin content: each CJK character counts as
 * one word, latin runs as one. Markdown/HTML markup and code blocks are
 * stripped so only prose is measured.
 */
export function countContentWords(texts: Array<string | null | undefined>): number {
  const plain = texts
    .filter(Boolean)
    .join("\n")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  const cjk = plain.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0;
  const latin = plain.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g)?.length ?? 0;
  return cjk + latin;
}

// ---------------------------------------------------------------------------
// Markdown assembly
// ---------------------------------------------------------------------------

/** Full note as a markdown file (same shape as the vault mirror). */
export function buildNoteMarkdownFile(
  input: Omit<VaultNoteContentInput, "labels">,
  labels: VaultSectionLabels,
): string | null {
  return buildNoteMarkdown({ ...input, labels })?.markdown ?? null;
}

// ---------------------------------------------------------------------------
// Card capture (PNG) + PDF pagination
// ---------------------------------------------------------------------------

export interface CapturedCard {
  /** image/png bytes */
  bytes: Uint8Array;
  dataUrl: string;
  /** CSS pixel size of the captured card (before device scaling). */
  width: number;
  height: number;
}

/** Rasterize the share card element to a 2x PNG. */
export async function captureCardPng(node: HTMLElement): Promise<CapturedCard> {
  const { domToPng } = await import("modern-screenshot");
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  // Very tall notes would blow past canvas pixel limits at 2x; drop to 1x.
  const scale = height * 2 > 16000 ? 1 : 2;
  const dataUrl = await domToPng(node, { scale });
  return { dataUrl, bytes: dataUrlToBytes(dataUrl), width, height };
}

export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export const PDF_A4 = { widthMm: 210, heightMm: 297, marginMm: 12 };

/** Pure pagination math: fit the card image onto A4 pages at full width. */
export function computePdfLayout(imgWidthPx: number, imgHeightPx: number): {
  contentWidthMm: number;
  contentHeightMm: number;
  totalHeightMm: number;
  pageCount: number;
} {
  const contentWidthMm = PDF_A4.widthMm - PDF_A4.marginMm * 2;
  const contentHeightMm = PDF_A4.heightMm - PDF_A4.marginMm * 2;
  const totalHeightMm = (imgHeightPx / imgWidthPx) * contentWidthMm;
  const pageCount = Math.max(1, Math.ceil(totalHeightMm / contentHeightMm));
  return { contentWidthMm, contentHeightMm, totalHeightMm, pageCount };
}

/** Slice the card long-image across A4 pages (image-based, non-selectable text). */
export async function cardPngToPdfBytes(card: CapturedCard): Promise<Uint8Array> {
  const { jsPDF } = await import("jspdf");
  const { contentWidthMm, contentHeightMm, totalHeightMm, pageCount } = computePdfLayout(
    card.width,
    card.height,
  );
  const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  for (let page = 0; page < pageCount; page++) {
    if (page > 0) pdf.addPage();
    // Same image re-drawn with a negative offset; each page only shows its slice.
    pdf.addImage(
      card.dataUrl,
      "PNG",
      PDF_A4.marginMm,
      PDF_A4.marginMm - page * contentHeightMm,
      contentWidthMm,
      totalHeightMm,
    );
  }
  return new Uint8Array(pdf.output("arraybuffer"));
}

// ---------------------------------------------------------------------------
// Delivery: save / system share / clipboard
// ---------------------------------------------------------------------------

interface DesktopAttachmentApi {
  saveBytes: (bytes: Uint8Array, fileName: string) => Promise<{ path: string } | null>;
}

function getDesktopAttachmentApi(): DesktopAttachmentApi | null {
  if (typeof window === "undefined") return null;
  const desktopWindow = window as Window & {
    desktopAPI?: { attachment?: DesktopAttachmentApi };
  };
  return desktopWindow.desktopAPI?.attachment ?? null;
}

function downloadViaBrowser(bytes: Uint8Array, fileName: string, mime: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

const MIME_BY_EXT: Record<string, string> = {
  md: "text/markdown;charset=utf-8",
  pdf: "application/pdf",
  png: "image/png",
};

/** Save dialog + write + reveal on desktop; blob download in the browser. */
export async function saveBytesToDisk(bytes: Uint8Array, fileName: string): Promise<boolean> {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const desktop = getDesktopAttachmentApi();
  if (desktop) {
    const result = await desktop.saveBytes(bytes, fileName);
    return !!result;
  }
  downloadViaBrowser(bytes, fileName, MIME_BY_EXT[ext] ?? "application/octet-stream");
  return true;
}

/**
 * Open the OS share sheet for the payload when the platform has one
 * (macOS); otherwise silently degrade to the save flow. Returns what happened
 * so the UI can toast accordingly.
 */
export async function shareOrSaveBytes(
  bytes: Uint8Array,
  fileName: string,
): Promise<"shared" | "saved"> {
  const share = getDesktopShareApi();
  if (share) {
    try {
      if (await share.shareFile(fileName, bytes)) return "shared";
    } catch {
      // No native share sheet (e.g. Windows) → save instead.
    }
  }
  await saveBytesToDisk(bytes, fileName);
  return "saved";
}

/** Copy a PNG to the system clipboard (async clipboard API). */
export async function copyImageBytesToClipboard(bytes: Uint8Array): Promise<void> {
  const blob = new Blob([new Uint8Array(bytes)], { type: "image/png" });
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
