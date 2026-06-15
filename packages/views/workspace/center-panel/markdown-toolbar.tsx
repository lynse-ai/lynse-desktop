"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@lynse/ui/components/ui/popover";
import {
  Bold,
  Italic,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Type,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Image,
  Undo,
} from "../../icons";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { executeAction, type MarkdownEditorAction } from "./editor-actions";
import { useTranslation } from "@lynse/core/i18n/react";

interface FloatingMarkdownToolbarProps {
  /** The active Milkdown editor instance. Toolbar is hidden when null. */
  editor: Editor | null;
}

interface CursorPos {
  top: number;
  left: number;
  visible: boolean;
}

export function FloatingMarkdownToolbar({ editor }: FloatingMarkdownToolbarProps) {
  const { t } = useTranslation();
  const [pos, setPos] = useState<CursorPos>({ top: 0, left: 0, visible: false });
  const rafRef = useRef<number>(0);
  /** Prevents focus loss (and selection clearing) when clicking toolbar buttons. */
  const keepFocus = useCallback((e: React.MouseEvent) => e.preventDefault(), []);
  /** Saved selection from the editor (restored before executing actions from popovers). */
  const savedSelRef = useRef<{ from: number; to: number }>({ from: 0, to: 0 });

  // Track cursor position via DOM events on the editor
  useEffect(() => {
    if (!editor) return;

    const viewRef: { current: EditorViewLike | null } = { current: null };
    editor.action((ctx) => {
      viewRef.current = ctx.get(editorViewCtx) as unknown as EditorViewLike;
    });
    const editorView = viewRef.current;
    if (!editorView) return;

    const dom = editorView.dom as HTMLElement;

    const updatePosition = () => {
      // Save the current selection before position update (so submenu actions can restore it)
      try {
        const { from, to } = editorView.state.selection;
        savedSelRef.current = { from, to };
      } catch { /* ignore */ }

      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        try {
          const { state } = editorView;
          const { from } = state.selection;
          const coords = editorView.coordsAtPos(from);
          if (coords) {
            setPos({
              top: coords.bottom + 4,
              left: coords.left,
              visible: document.hasFocus() && dom.contains(document.activeElement),
            });
          }
        } catch {
          // coordsAtPos can throw for invalid positions
        }
      });
    };

    const onFocus = () => updatePosition();
    const onBlur = (e: FocusEvent) => {
      // Don't hide if focus moves to the toolbar or a popover (they're portals in document.body)
      const related = e.relatedTarget as HTMLElement | null;
      if (related?.closest("[data-floating-toolbar]")) return;
      // Small delay: popovers may briefly move focus before opening
      setTimeout(() => {
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest("[data-floating-toolbar]") || active?.closest("[data-popup-open]")) return;
        if (dom.contains(document.activeElement)) return;
        setPos((p) => ({ ...p, visible: false }));
      }, 100);
    };

    dom.addEventListener("focus", onFocus, true);
    dom.addEventListener("blur", onBlur as EventListener, true);
    dom.addEventListener("click", updatePosition);
    dom.addEventListener("keyup", updatePosition);
    dom.addEventListener("input", updatePosition);
    dom.addEventListener("mouseup", updatePosition);

    // Initial position if already focused
    if (document.hasFocus() && dom.contains(document.activeElement)) {
      updatePosition();
    }

    return () => {
      cancelAnimationFrame(rafRef.current);
      dom.removeEventListener("focus", onFocus, true);
      dom.removeEventListener("blur", onBlur, true);
      dom.removeEventListener("click", updatePosition);
      dom.removeEventListener("keyup", updatePosition);
      dom.removeEventListener("input", updatePosition);
      dom.removeEventListener("mouseup", updatePosition);
    };
  }, [editor]);

  const run = useCallback(
    (action: MarkdownEditorAction, payload?: { alt?: string; url?: string }) => {
      // Restore saved selection before executing (critical for submenu actions where editor lost focus)
      editor?.action((ctx) => {
        const v = ctx.get(editorViewCtx) as unknown as EditorViewLike;
        try {
          (v.dom as HTMLElement).focus();
          const { from, to } = savedSelRef.current;
          if (from !== to) {
            const sel = TextSelection.create(v.state.doc, from, to);
            v.dispatch(v.state.tr.setSelection(sel));
          }
        } catch { /* best effort */ }
      });

      executeAction(editor, action, payload);

      // Refocus editor after action
      requestAnimationFrame(() => {
        editor?.action((ctx) => {
          const v = ctx.get(editorViewCtx) as unknown as EditorViewLike;
          (v.dom as HTMLElement).focus();
        });
      });
    },
    [editor],
  );

  if (!editor || !pos.visible) return null;

  return createPortal(
    <div
      data-floating-toolbar
      className="floating-toolbar pointer-events-auto z-50 flex h-10 items-center gap-1 rounded-lg border border-border/30 bg-popover px-2 shadow-lg shadow-black/10"
      style={{
        position: "fixed",
        top: pos.top,
        left: Math.max(8, pos.left - 20),
      }}
    >
      {/* H — Heading submenu */}
      <Popover>
        <PopoverTrigger className="toolbar-btn" onMouseDown={keepFocus}>
          <span className="text-sm font-bold">H</span>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" sideOffset={8} className="flex-row items-center gap-1 w-auto rounded-lg p-1.5 shadow-lg shadow-black/10">
          <HMenuItem icon={Heading1} label={t("toolbar.heading_1")} onClick={() => run("heading-1")} />
          <HMenuItem icon={Heading2} label={t("toolbar.heading_2")} onClick={() => run("heading-2")} />
          <HMenuItem icon={Heading3} label={t("toolbar.heading_3")} onClick={() => run("heading-3")} />
          <div className="mx-0.5 h-5 w-px bg-border/50" />
          <HMenuItem icon={Type} label={t("toolbar.paragraph")} onClick={() => run("paragraph")} />
        </PopoverContent>
      </Popover>

      {/* Aa — Text formatting submenu */}
      <Popover>
        <PopoverTrigger className="toolbar-btn" onMouseDown={keepFocus}>
          <span className="text-xs font-medium">Aa</span>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" sideOffset={8} className="flex-row items-center gap-1 w-auto rounded-lg p-1.5 shadow-lg shadow-black/10">
          <HMenuItem icon={Bold} label={t("toolbar.bold")} onClick={() => run("bold")} />
          <HMenuItem icon={Italic} label={t("toolbar.italic")} onClick={() => run("italic")} />
          <HMenuItem icon={Code} label={t("toolbar.inline_code")} onClick={() => run("inline-code")} />
        </PopoverContent>
      </Popover>

      {/* ≡ — List submenu */}
      <Popover>
        <PopoverTrigger className="toolbar-btn" onMouseDown={keepFocus}>
          <span className="text-sm">≡</span>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" sideOffset={8} className="flex-row items-center gap-1 w-auto rounded-lg p-1.5 shadow-lg shadow-black/10">
          <HMenuItem icon={List} label={t("toolbar.bullet_list")} onClick={() => run("bullet-list")} />
          <HMenuItem icon={ListOrdered} label={t("toolbar.ordered_list")} onClick={() => run("ordered-list")} />
          <HMenuItem icon={ListChecks} label={t("toolbar.task_list")} onClick={() => run("task-list")} />
        </PopoverContent>
      </Popover>

      <div className="mx-0.5 h-5 w-px bg-border/50" />

      {/* ❝ — Blockquote (direct) */}
      <button className="toolbar-btn" onMouseDown={keepFocus} onClick={() => run("blockquote")} title={t("toolbar.blockquote")}>
        <Quote className="size-3.5" />
      </button>

      {/* 🖼️ — Image popover */}
      <ImagePopover onInsert={(url, alt) => run("image", { url, alt })} />

      {/* Undo */}
      <button className="toolbar-btn" onMouseDown={keepFocus} onClick={() => run("undo")} title={t("toolbar.undo")}>
        <Undo className="size-3.5" />
      </button>
    </div>,
    document.body,
  );
}

// ── Types ───────────────────────────────────────────────────

interface EditorViewLike {
  state: {
    selection: { from: number; to: number };
    doc: import("@milkdown/kit/prose/model").Node;
    tr: import("@milkdown/kit/prose/state").Transaction;
  };
  coordsAtPos: (pos: number) => { top: number; bottom: number; left: number; right: number };
  dispatch: (tr: unknown) => void;
  dom: HTMLElement;
}

// ── Sub-components ──────────────────────────────────────────

/** Horizontal menu item: icon-only button with title tooltip. onMouseDown prevents editor blur. */
function HMenuItem({
  icon: Icon,
  label,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="toolbar-btn"
      title={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

function ImagePopover({ onInsert }: { onInsert: (url: string, alt: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [alt, setAlt] = useState("");

  const handleInsert = () => {
    if (!url.trim()) return;
    onInsert(url.trim(), alt.trim());
    setUrl("");
    setAlt("");
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="toolbar-btn">
        <Image className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={4} className="w-72 p-3">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium">{t("toolbar.insert_image")}</p>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t("toolbar.image_url")}
            className="w-full rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5 text-xs outline-none focus:border-primary/50"
            onKeyDown={(e) => e.key === "Enter" && handleInsert()}
          />
          <input
            value={alt}
            onChange={(e) => setAlt(e.target.value)}
            placeholder={t("toolbar.image_alt")}
            className="w-full rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5 text-xs outline-none focus:border-primary/50"
            onKeyDown={(e) => e.key === "Enter" && handleInsert()}
          />
          <button
            onClick={handleInsert}
            disabled={!url.trim()}
            className="flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
          >
            {t("toolbar.insert")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
