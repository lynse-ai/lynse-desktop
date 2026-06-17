"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
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

/** Toolbar placement (follows the current selection). */
interface CursorPos {
  top: number;
  left: number;
}

/** Which submenu is currently open (null = none). */
type OpenMenu = "heading" | "text" | "list" | null;

/** How long the toolbar lingers after the selection/focus is lost, so a
 *  quick hover can seamlessly re-open it. (Ported from tolaria.) */
const CLOSE_GRACE_MS = 160;
/** Delay before re-showing the toolbar after an IME composition ends, to
 *  avoid flicker on candidate confirmation. */
const COMPOSITION_SETTLE_MS = 250;

export function FloatingMarkdownToolbar({ editor }: FloatingMarkdownToolbarProps) {
  const { t } = useTranslation();
  /** Whether the editor currently has a non-empty text selection the toolbar
   *  could format. Drives the core "show" signal. */
  const [selectionVisible, setSelectionVisible] = useState(false);
  const [pos, setPos] = useState<CursorPos>({ top: 0, left: 0 });

  // Hover/focus/grace keep the toolbar open while interacting with it, even
  // if the editor's selection is momentarily lost.
  const [toolbarHovered, setToolbarHovered] = useState(false);
  const [toolbarHasFocus, setToolbarHasFocus] = useState(false);
  const [closeGraceActive, setCloseGraceActive] = useState(false);

  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const [imageOpen, setImageOpen] = useState(false);

  const rafRef = useRef<number>(0);
  /** Saved selection from the editor (restored before executing actions). */
  const savedSelRef = useRef<{ from: number; to: number }>({ from: 0, to: 0 });
  const toolbarRef = useRef<HTMLDivElement>(null);
  const prevSelectionVisibleRef = useRef(false);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isComposing = useEditorComposing(editor);

  // ── Cursor position + selection tracking ──────────────────
  useEffect(() => {
    if (!editor) return;

    const viewRef: { current: EditorViewLike | null } = { current: null };
    editor.action((ctx) => {
      viewRef.current = ctx.get(editorViewCtx) as unknown as EditorViewLike;
    });
    const editorView = viewRef.current;
    if (!editorView) return;

    const dom = editorView.dom as HTMLElement;

    const updateFromSelection = () => {
      try {
        const { from, to } = editorView.state.selection;
        savedSelRef.current = { from, to };
      } catch { /* ignore */ }

      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        try {
          const { state } = editorView;
          const { from, to } = state.selection;
          const hasSelection = from !== to;
          const focused = document.hasFocus() && dom.contains(document.activeElement);

          if (hasSelection && focused) {
            // Anchor to the top of the selection (use the earlier position).
            const anchor = from <= to ? from : to;
            const coords = editorView.coordsAtPos(anchor);
            if (coords) {
              setPos({ top: coords.bottom + 4, left: coords.left });
            }
          }
          setSelectionVisible(hasSelection && focused);
        } catch {
          // coordsAtPos can throw for invalid positions
        }
      });
    };

    const onFocus = () => updateFromSelection();
    const onBlur = (e: FocusEvent) => {
      const related = e.relatedTarget as HTMLElement | null;
      // Focus moving into the toolbar itself is not a real blur.
      if (related?.closest("[data-floating-toolbar]")) return;
      setTimeout(() => {
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest("[data-floating-toolbar]")) return;
        if (dom.contains(document.activeElement)) return;
        setSelectionVisible(false);
      }, 100);
    };

    dom.addEventListener("focus", onFocus, true);
    dom.addEventListener("blur", onBlur as EventListener, true);
    dom.addEventListener("click", updateFromSelection);
    dom.addEventListener("keyup", updateFromSelection);
    dom.addEventListener("input", updateFromSelection);
    dom.addEventListener("mouseup", updateFromSelection);

    if (document.hasFocus() && dom.contains(document.activeElement)) {
      updateFromSelection();
    }

    return () => {
      cancelAnimationFrame(rafRef.current);
      dom.removeEventListener("focus", onFocus, true);
      dom.removeEventListener("blur", onBlur as EventListener, true);
      dom.removeEventListener("click", updateFromSelection);
      dom.removeEventListener("keyup", updateFromSelection);
      dom.removeEventListener("input", updateFromSelection);
      dom.removeEventListener("mouseup", updateFromSelection);
    };
  }, [editor]);

  // ── Close-grace window (ported from tolaria) ──────────────
  // When every interaction signal drops, keep the toolbar visible briefly so a
  // hover can re-open it without a flash.
  useEffect(() => {
    const interactionActive = selectionVisible || toolbarHovered || toolbarHasFocus;

    if (interactionActive) {
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
      setCloseGraceActive(false);
    } else if (prevSelectionVisibleRef.current) {
      setCloseGraceActive(true);
      if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
      graceTimerRef.current = setTimeout(() => {
        graceTimerRef.current = null;
        setCloseGraceActive(false);
      }, CLOSE_GRACE_MS);
    }

    prevSelectionVisibleRef.current = selectionVisible;
  }, [selectionVisible, toolbarHovered, toolbarHasFocus]);

  useEffect(() => () => {
    if (graceTimerRef.current) clearTimeout(graceTimerRef.current);
  }, []);

  // ── Final visibility (tolaria's core formula) ─────────────
  const isOpen =
    !isComposing &&
    (selectionVisible || toolbarHovered || toolbarHasFocus || closeGraceActive);

  // Close submenus when clicking outside the toolbar
  useEffect(() => {
    if (!openMenu && !imageOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-floating-toolbar]")) {
        setOpenMenu(null);
        setImageOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [openMenu, imageOpen]);

  const run = useCallback(
    (action: MarkdownEditorAction, payload?: { alt?: string; url?: string }) => {
      // Close any open menu first
      setOpenMenu(null);
      setImageOpen(false);

      // Restore saved selection before executing
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

  const toggleMenu = useCallback((menu: OpenMenu) => {
    setOpenMenu((prev) => (prev === menu ? null : menu));
    setImageOpen(false);
  }, []);

  if (!editor || !isOpen) return null;

  return createPortal(
    <div
      ref={toolbarRef}
      data-floating-toolbar
      onPointerEnter={() => setToolbarHovered(true)}
      onPointerLeave={(e) => {
        if (isFocusStillWithinToolbar(e.currentTarget, e.relatedTarget)) return;
        setToolbarHovered(false);
      }}
      onFocusCapture={() => setToolbarHasFocus(true)}
      onBlurCapture={(e) => {
        if (isFocusStillWithinToolbar(e.currentTarget, e.relatedTarget)) return;
        setToolbarHasFocus(false);
      }}
      className="floating-toolbar pointer-events-auto z-50 flex h-10 items-center gap-1 rounded-lg border border-border/30 bg-popover px-2 shadow-lg shadow-black/10"
      style={{
        position: "fixed",
        top: pos.top,
        left: Math.max(8, Math.min(pos.left - 20, window.innerWidth - 320)),
      }}
    >
      {/* H — Heading submenu */}
      <div className="relative">
        <button className="toolbar-btn" onMouseDown={keepFocus} onClick={() => toggleMenu("heading")}>
          <span className="text-sm font-bold">H</span>
        </button>
        {openMenu === "heading" && (
          <SubMenu>
            <MenuBtn icon={Heading1} label={t("toolbar.heading_1")} keepFocus={keepFocus} onClick={() => run("heading-1")} />
            <MenuBtn icon={Heading2} label={t("toolbar.heading_2")} keepFocus={keepFocus} onClick={() => run("heading-2")} />
            <MenuBtn icon={Heading3} label={t("toolbar.heading_3")} keepFocus={keepFocus} onClick={() => run("heading-3")} />
            <div className="mx-0.5 h-5 w-px bg-border/50" />
            <MenuBtn icon={Type} label={t("toolbar.paragraph")} keepFocus={keepFocus} onClick={() => run("paragraph")} />
          </SubMenu>
        )}
      </div>

      {/* Aa — Text formatting submenu */}
      <div className="relative">
        <button className="toolbar-btn" onMouseDown={keepFocus} onClick={() => toggleMenu("text")}>
          <span className="text-xs font-medium">Aa</span>
        </button>
        {openMenu === "text" && (
          <SubMenu>
            <MenuBtn icon={Bold} label={t("toolbar.bold")} keepFocus={keepFocus} onClick={() => run("bold")} />
            <MenuBtn icon={Italic} label={t("toolbar.italic")} keepFocus={keepFocus} onClick={() => run("italic")} />
            <MenuBtn icon={Code} label={t("toolbar.inline_code")} keepFocus={keepFocus} onClick={() => run("inline-code")} />
          </SubMenu>
        )}
      </div>

      {/* ≡ — List submenu */}
      <div className="relative">
        <button className="toolbar-btn" onMouseDown={keepFocus} onClick={() => toggleMenu("list")}>
          <span className="text-sm">≡</span>
        </button>
        {openMenu === "list" && (
          <SubMenu>
            <MenuBtn icon={List} label={t("toolbar.bullet_list")} keepFocus={keepFocus} onClick={() => run("bullet-list")} />
            <MenuBtn icon={ListOrdered} label={t("toolbar.ordered_list")} keepFocus={keepFocus} onClick={() => run("ordered-list")} />
            <MenuBtn icon={ListChecks} label={t("toolbar.task_list")} keepFocus={keepFocus} onClick={() => run("task-list")} />
          </SubMenu>
        )}
      </div>

      <div className="mx-0.5 h-5 w-px bg-border/50" />

      {/* ❝ — Blockquote (direct) */}
      <button className="toolbar-btn" onMouseDown={keepFocus} onClick={() => run("blockquote")} title={t("toolbar.blockquote")}>
        <Quote className="size-3.5" />
      </button>

      {/* 🖼️ — Image popover */}
      <div className="relative">
        <button className="toolbar-btn" onMouseDown={keepFocus} onClick={() => { setImageOpen((v) => !v); setOpenMenu(null); }} title={t("toolbar.insert_image")}>
          <Image className="size-3.5" />
        </button>
        {imageOpen && (
          <div className="absolute bottom-full left-0 mb-2 z-50 w-72 rounded-lg border border-border/30 bg-popover p-3 shadow-lg shadow-black/10">
            <ImageForm
              onInsert={(url, alt) => run("image", { url, alt })}
              onCancel={() => setImageOpen(false)}
            />
          </div>
        )}
      </div>

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

// ── Helpers ─────────────────────────────────────────────────

/** Prevents focus loss (and selection clearing) when clicking toolbar buttons. */
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

/** Focus moving between toolbar children should not count as a real blur. */
function isFocusStillWithinToolbar(currentTarget: Element, nextTarget: EventTarget | null): boolean {
  return nextTarget instanceof Node && currentTarget.contains(nextTarget);
}

/**
 * Tracks whether an IME composition (CJK input methods, etc.) is in progress on
 * the editor. While composing, the toolbar is hidden so it doesn't overlay the
 * candidate window or jitter on confirmation. (Ported from tolaria.)
 */
function useEditorComposing(editor: Editor | null): boolean {
  const [isComposing, setIsComposing] = useState(false);
  const composingRef = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!editor) return;

    const viewRef: { current: EditorViewLike | null } = { current: null };
    editor.action((ctx) => {
      viewRef.current = ctx.get(editorViewCtx) as unknown as EditorViewLike;
    });
    const view = viewRef.current;
    const dom = view?.dom as HTMLElement | null;
    if (!dom) return;

    const clearSettle = () => {
      if (settleTimerRef.current) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
    };
    const update = (next: boolean) => {
      if (composingRef.current === next) return;
      composingRef.current = next;
      setIsComposing(next);
    };
    const start = () => { clearSettle(); update(true); };
    const finish = () => {
      clearSettle();
      settleTimerRef.current = setTimeout(() => {
        settleTimerRef.current = null;
        update(false);
      }, COMPOSITION_SETTLE_MS);
    };

    const onStart = (e: CompositionEvent) => {
      if (e.target instanceof Node && dom.contains(e.target)) start();
    };
    const onEnd = (e: CompositionEvent) => {
      if (!composingRef.current && !(e.target instanceof Node && dom.contains(e.target))) return;
      finish();
    };

    dom.addEventListener("compositionstart", onStart, true);
    dom.addEventListener("compositionupdate", onStart, true);
    dom.addEventListener("compositionend", onEnd, true);
    dom.addEventListener("compositioncancel", onEnd as EventListener, true);

    return () => {
      clearSettle();
      dom.removeEventListener("compositionstart", onStart, true);
      dom.removeEventListener("compositionupdate", onStart, true);
      dom.removeEventListener("compositionend", onEnd, true);
      dom.removeEventListener("compositioncancel", onEnd as EventListener, true);
    };
  }, [editor]);

  return isComposing;
}

// ── Sub-components ──────────────────────────────────────────

/** Floating submenu panel that appears above the toolbar. */
function SubMenu({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute bottom-full left-0 mb-2 z-50 flex items-center gap-1 rounded-lg border border-border/30 bg-popover p-1.5 shadow-lg shadow-black/10 whitespace-nowrap">
      {children}
    </div>
  );
}

/** Icon-only button inside a submenu. onMouseDown prevents editor blur. */
function MenuBtn({
  icon: Icon,
  label,
  keepFocus,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  keepFocus: (e: React.MouseEvent) => void;
  onClick: () => void;
}) {
  return (
    <button
      className="toolbar-btn"
      title={label}
      onMouseDown={keepFocus}
      onClick={onClick}
    >
      <Icon className="size-3.5" />
    </button>
  );
}

/** Image URL/alt input form. */
function ImageForm({ onInsert, onCancel }: { onInsert: (url: string, alt: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [alt, setAlt] = useState("");

  const handleInsert = () => {
    if (!url.trim()) return;
    onInsert(url.trim(), alt.trim());
  };

  return (
    <div className="flex flex-col gap-2" onMouseDown={(e) => e.stopPropagation()}>
      <p className="text-xs font-medium">{t("toolbar.insert_image")}</p>
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={t("toolbar.image_url")}
        className="w-full rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5 text-xs outline-none focus:border-primary/50"
        onKeyDown={(e) => { if (e.key === "Enter") handleInsert(); if (e.key === "Escape") onCancel(); }}
      />
      <input
        value={alt}
        onChange={(e) => setAlt(e.target.value)}
        placeholder={t("toolbar.image_alt")}
        className="w-full rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5 text-xs outline-none focus:border-primary/50"
        onKeyDown={(e) => { if (e.key === "Enter") handleInsert(); if (e.key === "Escape") onCancel(); }}
      />
      <div className="flex gap-2">
        <button
          onClick={handleInsert}
          disabled={!url.trim()}
          className="flex-1 flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
        >
          {t("toolbar.insert")}
        </button>
        <button
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
