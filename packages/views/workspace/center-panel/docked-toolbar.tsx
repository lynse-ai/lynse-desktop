"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link2,
  Heading1,
  Heading2,
  Heading3,
  Type,
  List,
  ListOrdered,
  ListChecks,
  Quote,
  Minus,
  Image,
  Sparkles,
  Undo,
  Redo2,
} from "../../icons";
import type { Editor } from "@milkdown/kit/core";
import { editorViewCtx } from "@milkdown/kit/core";
import { TextSelection } from "@milkdown/kit/prose/state";
import { resolveCommand, type MarkdownEditorAction } from "./editor-actions";
import { useTranslation } from "@lynse/core/i18n/react";
import { getAuthStore } from "@lynse/core/auth";
import { getWorkspaceState } from "../store";
import { useChatStore } from "../hooks/use-chat-store";
import { buildSelectionPrompt, SELECTION_AI_ACTIONS, type SelectionAiActionId } from "./selection-ai";

interface DockedMarkdownToolbarProps {
  /** The active Milkdown editor instance. Toolbar renders inert when null. */
  editor: Editor | null;
}

/**
 * Which popover is currently open (null = none). Unlike the old selection
 * toolbar these open to the RIGHT of the rail; they render through a portal
 * with fixed coordinates so the rail's own box can scroll internally without
 * clipping them.
 */
type OpenPopover = "link" | "image" | "ai" | null;

/** Live snapshot of the editor state used for active-button highlighting and
 *  AI/link enablement. */
interface EditorSnapshot {
  /** Current block context, e.g. "paragraph" | "heading-2" | "bullet-list". */
  block: string;
  /** Active inline mark type names at the cursor. */
  marks: string[];
  /** Whether the editor holds a non-empty selection. */
  hasSelection: boolean;
}

const EMPTY_SNAPSHOT: EditorSnapshot = { block: "", marks: [], hasSelection: false };

/** Horizontal gap between a rail trigger and its popover panel. */
const POPOVER_GAP = 8;

/**
 * Always-visible vertical Markdown toolbar docked to the left edge of the
 * editing column. Replaces the selection-gated floating bar: every tool stays
 * reachable while the user reads or scrolls, and the full toolset renders at
 * once (desktop windows are large — nothing collapses into submenus except
 * URL/AI popovers, which would be too wide for the rail itself).
 *
 * The rail is `position: sticky` within the editing column so it follows the
 * viewport while the document scrolls.
 */
export function DockedMarkdownToolbar({ editor }: DockedMarkdownToolbarProps) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<EditorSnapshot>(EMPTY_SNAPSHOT);
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);
  /** Anchor rect for the open popover (fixed positioning via portal). */
  const [popoverAnchor, setPopoverAnchor] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  /** Saved selection from the editor (restored before executing actions). */
  const savedSelRef = useRef<{ from: number; to: number }>({ from: 0, to: 0 });
  const triggerRefs = useRef<Record<Exclude<OpenPopover, null>, HTMLButtonElement | null>>({
    link: null,
    image: null,
    ai: null,
  });

  // ── Selection + active-state tracking ──────────────────────
  useEffect(() => {
    if (!editor) return;

    const viewRef: { current: EditorViewLike | null } = { current: null };
    editor.action((ctx) => {
      viewRef.current = ctx.get(editorViewCtx) as unknown as EditorViewLike;
    });
    const view = viewRef.current;
    const dom = view?.dom as HTMLElement | undefined;
    if (!view || !dom) return;

    const readSnapshot = () => {
      try {
        const { from, to } = view.state.selection;
        savedSelRef.current = { from, to };
        setSnapshot(describeSelection(view.state));
      } catch {
        // Positions can go stale mid-transaction — keep the last snapshot.
      }
    };

    // ProseMirror updates selection synchronously; a rAF batch keeps rapid
    // typing from flooding React state updates.
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(readSnapshot);
    };

    dom.addEventListener("click", schedule);
    dom.addEventListener("keyup", schedule);
    dom.addEventListener("input", schedule);
    dom.addEventListener("mouseup", schedule);
    dom.addEventListener("focus", schedule, true);
    document.addEventListener("selectionchange", schedule);

    readSnapshot();

    return () => {
      cancelAnimationFrame(raf);
      dom.removeEventListener("click", schedule);
      dom.removeEventListener("keyup", schedule);
      dom.removeEventListener("input", schedule);
      dom.removeEventListener("mouseup", schedule);
      dom.removeEventListener("focus", schedule, true);
      document.removeEventListener("selectionchange", schedule);
      setSnapshot(EMPTY_SNAPSHOT);
    };
  }, [editor]);

  // ── Popover trigger coordinates + outside-click closing ────
  useEffect(() => {
    if (!openPopover) return;
    const trigger = triggerRefs.current[openPopover];
    if (trigger) {
      const rect = trigger.getBoundingClientRect();
      setPopoverAnchor({ top: rect.top, left: rect.right + POPOVER_GAP });
    }
    const handlePointerOrResize = () => {
      const current = triggerRefs.current[openPopover];
      if (!current) return;
      const rect = current.getBoundingClientRect();
      setPopoverAnchor({ top: rect.top, left: rect.right + POPOVER_GAP });
    };
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-docked-toolbar]") && !target.closest("[data-docked-popover]")) {
        setOpenPopover(null);
      }
    };
    window.addEventListener("scroll", handlePointerOrResize, true);
    window.addEventListener("resize", handlePointerOrResize);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      window.removeEventListener("scroll", handlePointerOrResize, true);
      window.removeEventListener("resize", handlePointerOrResize);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [openPopover]);

  const run = useCallback(
    (action: MarkdownEditorAction, payload?: { url?: string; alt?: string }) => {
      setOpenPopover(null);
      if (!editor) return;

      // Execute focus → selection restore → command dispatch atomically so
      // the selection survives clicking the rail after browsing elsewhere.
      editor.action((ctx) => {
        const v = ctx.get(editorViewCtx) as unknown as EditorViewLike;
        try {
          (v.dom as HTMLElement).focus();

          const { from, to } = savedSelRef.current;
          if (from > 0 || to > 0) {
            const sel = TextSelection.create(v.state.doc, Math.min(from, v.state.doc.content.size), Math.min(to, v.state.doc.content.size));
            v.dispatch(v.state.tr.setSelection(sel));
          }

          const cmdFn = resolveCommand(action, payload);
          if (cmdFn) {
            const result = cmdFn(ctx);
            console.debug(`[docked-toolbar] "${action}" → ${result}`);
          }
        } catch (err) {
          console.warn(`[docked-toolbar] Failed to execute "${action}":`, err);
        }
      });

      requestAnimationFrame(() => {
        editor.action((ctx) => {
          const v = ctx.get(editorViewCtx) as unknown as EditorViewLike;
          (v.dom as HTMLElement).focus();
        });
      });
    },
    [editor],
  );

  const togglePopover = useCallback(
    (popover: Exclude<OpenPopover, null>) => {
      setOpenPopover((prev) => {
        if (prev === popover) return null;
        const trigger = triggerRefs.current[popover];
        if (trigger) {
          const rect = trigger.getBoundingClientRect();
          setPopoverAnchor({ top: rect.top, left: rect.right + POPOVER_GAP });
        }
        return popover;
      });
    },
    [],
  );

  /**
   * Hand a built prompt to 小灵 in the side panel — same channel and file
   * scoping the floating toolbar used before it.
   */
  const sendSelectionPrompt = useCallback((prompt: string) => {
    const fileId = getWorkspaceState().selectedItemId;
    if (!fileId) return;
    const ws = getWorkspaceState();
    if (!ws.chatPanelVisible) ws.toggleChatPanel();
    const chat = useChatStore.getState();
    chat.setUserId(getAuthStore()?.getState().user?.id ?? "user");
    chat.hydrate();
    chat.setActiveAssistant("lynse");
    chat.openFileChat(fileId);
    chat.sendMessage(prompt, fileId, true, undefined, { assistant: "lynse", contextFileId: fileId });
  }, []);

  /** Read the saved selection and dispatch the picked AI action as a prompt. */
  const runAiAction = useCallback(
    (actionId: SelectionAiActionId) => {
      setOpenPopover(null);
      if (!editor) return;
      let selection = "";
      editor.action((ctx) => {
        const v = ctx.get(editorViewCtx) as unknown as EditorViewLike;
        try {
          const { from, to } = savedSelRef.current;
          if (from !== to) selection = v.state.doc.textBetween(from, to, "\n");
        } catch {
          // Stale positions after an edit — treat as no selection.
        }
      });
      const passage = selection.trim();
      if (!passage) return;
      sendSelectionPrompt(buildSelectionPrompt(t(`toolbar.ai_prompt_${actionId}`), passage));
    },
    [editor, t, sendSelectionPrompt],
  );

  const active = (block: string) => snapshot.block === block;
  const markActive = (name: string) => snapshot.marks.includes(name);
  const hasSelection = snapshot.hasSelection;

  if (!editor) {
    return <div className="w-11 shrink-0 self-start" aria-hidden="true" />;
  }

  return (
    <>
      <div
        data-docked-toolbar
        // Sticky keeps the rail pinned to the scrollport while the note body
        // scrolls past — "browse and edit at the same time" is the whole point.
        // On unusually short windows the rail scrolls internally instead of
        // letting its bottom tools fall below the fold.
        className="sticky top-0 z-20 flex max-h-[calc(100vh-3rem)] w-11 shrink-0 self-start flex-col items-center gap-0.5 overflow-y-auto rounded-lg border border-border/30 glass-overlay p-1"
      >
        {/* ── Block types ── */}
        <RailButton label={t("toolbar.paragraph")} active={active("paragraph")} onClick={() => run("paragraph")}>
          <Type className="size-3.5" />
        </RailButton>
        <RailButton label={t("toolbar.heading_1")} active={active("heading-1")} onClick={() => run("heading-1")}>
          <Heading1 className="size-3.5" />
        </RailButton>
        <RailButton label={t("toolbar.heading_2")} active={active("heading-2")} onClick={() => run("heading-2")}>
          <Heading2 className="size-3.5" />
        </RailButton>
        <RailButton label={t("toolbar.heading_3")} active={active("heading-3")} onClick={() => run("heading-3")}>
          <Heading3 className="size-3.5" />
        </RailButton>

        <RailDivider />

        {/* ── Inline marks ── */}
        <RailButton label={t("toolbar.bold")} active={markActive("strong")} onClick={() => run("bold")}>
          <Bold className="size-3.5" />
        </RailButton>
        <RailButton label={t("toolbar.italic")} active={markActive("emphasis")} onClick={() => run("italic")}>
          <Italic className="size-3.5" />
        </RailButton>
        <RailButton label={t("toolbar.strikethrough")} active={markActive("strike_through")} onClick={() => run("strikethrough")}>
          <Strikethrough className="size-3.5" />
        </RailButton>
        <RailButton label={t("toolbar.inline_code")} active={markActive("inlineCode")} onClick={() => run("inline-code")}>
          <Code className="size-3.5" />
        </RailButton>
        <RailButton
          label={t("toolbar.link")}
          active={markActive("link")}
          disabled={!hasSelection && !markActive("link")}
          onClick={() => togglePopover("link")}
          triggerRef={(el) => { triggerRefs.current.link = el; }}
        >
          <Link2 className="size-3.5" />
        </RailButton>

        <RailDivider />

        {/* ── Lists ── */}
        <RailButton label={t("toolbar.bullet_list")} active={active("bullet-list")} onClick={() => run("bullet-list")}>
          <List className="size-3.5" />
        </RailButton>
        <RailButton label={t("toolbar.ordered_list")} active={active("ordered-list")} onClick={() => run("ordered-list")}>
          <ListOrdered className="size-3.5" />
        </RailButton>
        <RailButton label={t("toolbar.task_list")} active={active("task-list")} onClick={() => run("task-list")}>
          <ListChecks className="size-3.5" />
        </RailButton>

        <RailDivider />

        {/* ── Blocks ── */}
        <RailButton label={t("toolbar.blockquote")} active={active("blockquote")} onClick={() => run("blockquote")}>
          <Quote className="size-3.5" />
        </RailButton>
        <RailButton label={t("toolbar.horizontal_rule")} onClick={() => run("horizontal-rule")}>
          <Minus className="size-3.5" />
        </RailButton>

        <RailDivider />

        {/* ── Insert / AI / history ── */}
        <RailButton
          label={t("toolbar.insert_image")}
          onClick={() => togglePopover("image")}
          triggerRef={(el) => { triggerRefs.current.image = el; }}
        >
          <Image className="size-3.5" />
        </RailButton>
        <RailButton
          label={hasSelection ? t("toolbar.ai_menu") : t("toolbar.ai_needs_selection")}
          disabled={!hasSelection}
          onClick={() => togglePopover("ai")}
          triggerRef={(el) => { triggerRefs.current.ai = el; }}
        >
          <Sparkles className="size-3.5 text-primary/70" />
        </RailButton>

        <RailDivider />

        {/* Undo/redo share one row so the rail stays within short viewports. */}
        <div className="flex w-full items-center justify-center gap-0.5">
          <RailButton label={t("toolbar.undo")} onClick={() => run("undo")} className="w-[15px] px-0">
            <Undo className="size-3.5" />
          </RailButton>
          <RailButton label={t("toolbar.redo")} onClick={() => run("redo")} className="w-[15px] px-0">
            <Redo2 className="size-3.5" />
          </RailButton>
        </div>
      </div>

      {openPopover === "link" && (
        <ToolbarPopover anchor={popoverAnchor}>
          <LinkForm
            active={markActive("link")}
            onApply={(url) => run("link", { url })}
            onRemove={() => run("link", { url: "" })}
            onCancel={() => setOpenPopover(null)}
          />
        </ToolbarPopover>
      )}
      {openPopover === "image" && (
        <ToolbarPopover anchor={popoverAnchor}>
          <ImageForm
            onInsert={(url, alt) => run("image", { url, alt })}
            onCancel={() => setOpenPopover(null)}
          />
        </ToolbarPopover>
      )}
      {openPopover === "ai" && (
        <ToolbarPopover anchor={popoverAnchor}>
          <div className="flex flex-col items-stretch rounded-lg border border-border/30 glass-overlay p-1.5 whitespace-nowrap">
            {SELECTION_AI_ACTIONS.map((actionId) => (
              <button
                key={actionId}
                type="button"
                className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent/60"
                onClick={() => runAiAction(actionId)}
              >
                <Sparkles className="size-3 shrink-0 text-primary/70" />
                {t(`toolbar.ai_${actionId}`)}
              </button>
            ))}
          </div>
        </ToolbarPopover>
      )}
    </>
  );
}

// ── Rail primitives ─────────────────────────────────────────

/** Icon button on the rail. Clicks never steal focus from the editor. */
function RailButton({
  label,
  active = false,
  disabled = false,
  onClick,
  triggerRef,
  className = "",
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  /** Registers the button element as a popover anchor (optional). */
  triggerRef?: (el: HTMLButtonElement | null) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      ref={triggerRef}
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors ${
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground"
      } disabled:pointer-events-none disabled:opacity-35 ${className}`}
    >
      {children}
    </button>
  );
}

/** Hairline separator between tool groups. */
function RailDivider() {
  return <div className="my-0.5 h-px w-6 shrink-0 bg-border/50" />;
}

/**
 * Popover panel rendered through a portal at fixed coordinates next to its
 * rail trigger — lets the rail itself scroll without clipping the panel.
 */
function ToolbarPopover({ anchor, children }: { anchor: { top: number; left: number }; children: React.ReactNode }) {
  // Clamp vertically so tall panels stay on screen next to bottom-anchored triggers.
  const top = Math.min(anchor.top, Math.max(8, window.innerHeight - 240));
  return createPortal(
    <div
      data-docked-popover
      className="floating-toolbar pointer-events-auto z-50"
      style={{ position: "fixed", top, left: anchor.left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

// ── Popover forms ───────────────────────────────────────────

/** Link URL form — apply a href to the selection or strip an existing link. */
function LinkForm({
  active,
  onApply,
  onRemove,
  onCancel,
}: {
  active: boolean;
  onApply: (url: string) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");

  const handleApply = () => {
    if (!url.trim()) return;
    onApply(url.trim());
  };

  return (
    <div className="flex w-72 flex-col gap-2 rounded-lg border border-border/30 glass-overlay p-3">
      <p className="text-xs font-medium">{t("toolbar.link")}</p>
      <input
        value={url}
        autoFocus
        onChange={(e) => setUrl(e.target.value)}
        placeholder={t("toolbar.link_url")}
        className="w-full rounded-md border border-border/50 bg-muted/30 px-2.5 py-1.5 text-xs outline-none focus:border-primary/50"
        onKeyDown={(e) => {
          if (e.key === "Enter") handleApply();
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="flex gap-2">
        <button
          onClick={handleApply}
          disabled={!url.trim()}
          className="flex-1 flex items-center justify-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
        >
          {t("toolbar.insert")}
        </button>
        {active && (
          <button
            onClick={onRemove}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent/50"
          >
            {t("toolbar.remove_link")}
          </button>
        )}
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

/** Image URL/alt input form (ported from the floating toolbar). */
function ImageForm({ onInsert, onCancel }: { onInsert: (url: string, alt: string) => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState("");
  const [alt, setAlt] = useState("");

  const handleInsert = () => {
    if (!url.trim()) return;
    onInsert(url.trim(), alt.trim());
  };

  return (
    <div className="flex w-72 flex-col gap-2 rounded-lg border border-border/30 glass-overlay p-3">
      <p className="text-xs font-medium">{t("toolbar.insert_image")}</p>
      <input
        value={url}
        autoFocus
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

// ── Editor state helpers ────────────────────────────────────

interface EditorViewLike {
  state: {
    selection: {
      from: number;
      to: number;
      $from: { marks: () => { type: { name: string } }[]; depth: number; node: (d: number) => { type: { name: string }; attrs: { level?: unknown; checked?: unknown } } };
    };
    doc: import("@milkdown/kit/prose/model").Node;
    tr: import("@milkdown/kit/prose/state").Transaction;
  };
  dispatch: (tr: unknown) => void;
  dom: HTMLElement;
}

/** Derive the active block + marks snapshot from a ProseMirror editor state. */
function describeSelection(state: EditorViewLike["state"]): EditorSnapshot {
  const { from, to, $from } = state.selection;
  const marks = $from.marks().map((m) => m.type.name);

  // Walk from the innermost block outward: a paragraph inside a list item
  // reports the list; a paragraph inside a blockquote reports the quote.
  let block = "paragraph";
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    const name = node.type.name;
    if (name === "heading") {
      block = `heading-${node.attrs.level ?? 1}`;
      break;
    }
    // GFM task lists are plain list_item nodes carrying a `checked` attr.
    if (name === "list_item" && node.attrs.checked != null) { block = "task-list"; break; }
    if (name === "bullet_list") { block = "bullet-list"; break; }
    if (name === "ordered_list") { block = "ordered-list"; break; }
    if (name === "blockquote") { block = "blockquote"; break; }
    if (name === "code_block") { block = "code-block"; break; }
  }

  return { block, marks, hasSelection: from !== to };
}
