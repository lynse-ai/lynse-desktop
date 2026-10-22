"use client";

import { useEffect, type ReactNode } from "react";
import { create } from "zustand";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cn } from "@lynse/ui/lib/utils";
import { useTranslation } from "@lynse/core/i18n/react";
import { useNavigation } from "../navigation";
import { isTauri, isMacDesktop, useMaximized } from "./use-maximized";
import { ArrowLeft, ArrowRight, PanelLeft, Minus, Square, Copy, X } from "../icons";
import { RecordingTitleBarPill, useRecordingPillVisible } from "./recording-title-pill";

export const TITLE_BAR_HEIGHT = 34;

// Windows/Linux desktop windows ship without native title bar (see
// `tauri.windows.conf.json`), so the app bar is the only caption area there and
// has to carry the window buttons itself. macOS keeps its traffic lights.
// The login page keys off this too: it mounts a caption band of its own.
export const showWindowControls = isTauri && !isMacDesktop;

/* ── Slot store ────────────────────────────────────────────────────────────
 * The shell-level bar is one strip for the whole window, but only the mounted
 * page knows its conversation title / breadcrumb, its right-side actions and
 * whether it has a collapsible middle panel. Pages declare those through
 * <TitleBarSlot>; unmounting clears the registration, so switching routes
 * resets the bar to the default route title automatically.
 * ------------------------------------------------------------------------- */

/** A page's collapsible middle column (chat history drawer, notes file list). */
export interface MiddlePanelToggle {
  /** True when the panel is currently hidden. */
  collapsed: boolean;
  onToggle: () => void;
  /** Accessible label / tooltip for the toggle button. */
  label?: string;
  /**
   * The panel's current width in px (content-area local). While open, the bar
   * pins its divider at rail + this width and starts the title zone there, so
   * the bar's split mirrors the content split below. Omit when the page has
   * no panel to show.
   */
  panelWidth?: number;
}

interface TitleBarSlotState {
  title: ReactNode | null;
  /** Horizontal alignment of the registered title inside the center zone. */
  titleAlign: "start" | "center";
  actions: ReactNode | null;
  middleToggle: MiddlePanelToggle | null;
  set: (partial: Partial<Omit<TitleBarSlotState, "set" | "clear">>) => void;
  clear: () => void;
}

const useTitleBarSlotStore = create<TitleBarSlotState>((set) => ({
  title: null,
  titleAlign: "start",
  actions: null,
  middleToggle: null,
  set: (partial) => set(partial),
  clear: () => set({ title: null, actions: null, middleToggle: null }),
}));

/**
 * Declarative registration into the app title bar. Render inside a page to
 * replace the default route title and/or add right-side actions and a
 * middle-panel toggle. The effect re-syncs on every render on purpose — the
 * props are usually fresh JSX whose identity changes with page state.
 */
export function TitleBarSlot({
  title,
  titleAlign = "start",
  actions,
  middleToggle,
}: {
  title?: ReactNode;
  /** "start" hugs the zone divider (breadcrumbs); "center" floats mid-zone (assistant switcher). */
  titleAlign?: "start" | "center";
  actions?: ReactNode;
  middleToggle?: MiddlePanelToggle;
}) {
  const set = useTitleBarSlotStore((s) => s.set);
  const clear = useTitleBarSlotStore((s) => s.clear);

  useEffect(() => {
    set({
      title: title ?? null,
      titleAlign,
      actions: actions ?? null,
      middleToggle: middleToggle ?? null,
    });
  });
  useEffect(() => () => clear(), [clear]);

  return null;
}

/* ── The bar ──────────────────────────────────────────────────────────────
 * Layout (ChatGPT-desktop style):
 *
 *   [traffic lights] [back][forward][middle] │ [ centered title ] │ [actions]
 *
 * The whole strip is a drag region; interactive clusters opt out. Double-
 * click toggles maximize like a native macOS title bar. Pages register their
 * center content through <TitleBarSlot>; routes without a slot keep the
 * center empty — the bar never echoes the current page's nav label.
 * ------------------------------------------------------------------------ */

export function AppTitleBar() {
  const { t } = useTranslation();
  const { back, forward, canGoBack, canGoForward } = useNavigation();
  const slotTitle = useTitleBarSlotStore((s) => s.title);
  const titleAlign = useTitleBarSlotStore((s) => s.titleAlign);
  const slotActions = useTitleBarSlotStore((s) => s.actions);
  const middleToggle = useTitleBarSlotStore((s) => s.middleToggle);
  // While the recording pill is on screen, start-aligned titles (breadcrumbs)
  // pad their right edge so long text truncates instead of sliding under the
  // pill. Center-aligned titles (the chat switcher) are compact and stay put.
  const pillVisible = useRecordingPillVisible();

  // While a page's middle panel (chat history drawer, notes file list) is
  // open, the bar mirrors the content split below it: the left cluster
  // stretches so the divider after it lands exactly on the panel's right
  // edge, and the title zone starts there. Deterministic: the page declares
  // the panel width, no DOM measurement.
  // List edge in window coords = icon rail (52) + content-card margin (5) +
  // border (1) under vibrancy; without vibrancy the card is full-bleed (52).
  const vibrant =
    typeof document !== "undefined" &&
    document.documentElement.dataset.windowEffects === "vibrancy";
  const railOffset = vibrant ? 58 : 52;
  const panelWidth = middleToggle && !middleToggle.collapsed ? middleToggle.panelWidth ?? 0 : 0;
  const panelEdge = panelWidth > 0 ? railOffset + panelWidth : null;
  // The zone divider carries the bar's gap-1 (4px) plus its own mx-1 (4px)
  // before the 1px line; shrink the stretched cluster by the same amount so
  // the line — not its margins — lands on the panel edge.
  const DIVIDER_LEAD = 8;
  const leftZoneWidth = panelEdge != null ? Math.max(0, panelEdge - DIVIDER_LEAD) : null;

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (!isTauri) return;
    getCurrentWindow().toggleMaximize().catch(() => {});
  };

  return (
    <div
      className={cn(
        "relative flex shrink-0 select-none items-center gap-1",
        // The caption buttons own the top-right corner, so no padding there.
        !showWindowControls && "pr-2",
      )}
      style={{ height: TITLE_BAR_HEIGHT }}
      data-tauri-drag-region
      onDoubleClick={handleDoubleClick}
    >
      {/* ── Left: window controls clearance + navigation. With a middle panel
            open the cluster stretches to the panel's right edge (rail offset
            + panel width), so the divider after it lands exactly on the
            content split below and the title zone starts there — no margins
            to double-count. The stretch area stays a drag region; the
            buttons opt out per-element. (2px optical correction, matching
            the center/right zones.) ── */}
      <div
        className="flex translate-y-0.5 items-center gap-0.5 pl-2"
        style={leftZoneWidth != null ? { width: leftZoneWidth } : undefined}
        data-tauri-drag-region
      >
        {/* Native traffic lights overlay this corner on macOS: the group
            anchors at x = 20 (tauri.conf.json) and spans ~52pt at the system
            stride, so keep the nav buttons clear of it with a matching gap. */}
        {isMacDesktop && <div className="w-[76px] shrink-0" />}
        <BarButton
          label={t("layout.back")}
          disabled={canGoBack === false}
          onClick={back}
        >
          <ArrowLeft className="size-4" />
        </BarButton>
        <BarButton
          label={t("layout.forward")}
          disabled={canGoForward === false}
          onClick={() => forward?.()}
        >
          <ArrowRight className="size-4" />
        </BarButton>
        {middleToggle && (
          <BarButton
            label={middleToggle.label}
            active={!middleToggle.collapsed}
            onClick={middleToggle.onToggle}
          >
            <PanelLeft className="size-4" />
          </BarButton>
        )}
      </div>

      {/* ── Divider between the left zone and the title zone. With a middle
            panel open the left zone already stretches to the panel's edge, so
            this single divider tracks the content split automatically. ── */}
      <ZoneDivider />

      {/* ── Center: page-registered title (breadcrumb / conversation /
            assistant switcher), left-aligned after the divider (ChatGPT-
            desktop style — the title leads its zone; the chat page declares
            "center" for its switcher). No slot → empty drag strip. Shifted
            2px down — text reads optically high in the short bar. `relative`
            hosts the floating recording pill at the zone's right end; the
            pill is absolutely positioned so the layout below never shifts. ── */}
      <div
        className={cn(
          "relative flex min-w-0 flex-1 translate-y-0.5 items-center gap-1.5 px-4",
          titleAlign === "center" ? "justify-center" : "justify-start",
          pillVisible && titleAlign !== "center" && "pr-32",
        )}
        data-tauri-drag-region
      >
        {slotTitle}
        <RecordingTitleBarPill />
      </div>

      {/* Only pages with registered actions get the closing divider; with an
          empty actions zone the line would just dangle at the window edge. */}
      {slotActions != null && <ZoneDivider />}

      {/* ── Right: page actions (same 2px optical correction) ── */}
      <div
        className="flex shrink-0 translate-y-0.5 items-center gap-1"
        data-tauri-drag-region={false}
      >
        {slotActions}
      </div>

      {showWindowControls && <WindowControls />}
    </div>
  );
}

function BarButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-[30px] shrink-0 items-center justify-center rounded-lg transition-colors",
        active
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        disabled && "pointer-events-none opacity-30",
      )}
    >
      {children}
    </button>
  );
}

function ZoneDivider() {
  return <div className="mx-1 h-[18px] w-px shrink-0 bg-border/60" aria-hidden="true" />;
}

/**
 * Caption buttons for the frameless Windows/Linux window. Flush to the top-right
 * corner and full bar height, matching where the OS put them before: the close
 * target sits at the window edge, not inset by the app's own padding.
 *
 * Renders nothing on macOS (native traffic lights) and in the web build. The
 * login page mounts this in its own caption band with `allowMaximize: false` —
 * the welcome window keeps its normal look but the maximize button is a no-op.
 */
export function WindowControls({ allowMaximize = true }: { allowMaximize?: boolean }) {
  const { t } = useTranslation();
  const maximized = useMaximized();

  if (!showWindowControls) return null;

  return (
    <div
      className="flex h-full shrink-0 items-stretch self-stretch"
      data-tauri-drag-region={false}
    >
      <CaptionButton label={t("layout.window_minimize")} onClick={() => void getCurrentWindow().minimize()}>
        <Minus className="size-3.5" strokeWidth={1.5} />
      </CaptionButton>
      <CaptionButton
        label={t(maximized ? "layout.window_restore" : "layout.window_maximize")}
        onClick={allowMaximize ? () => void getCurrentWindow().toggleMaximize() : undefined}
      >
        {maximized ? (
          <Copy className="size-3.5" strokeWidth={1.5} />
        ) : (
          <Square className="size-3.5" strokeWidth={1.5} />
        )}
      </CaptionButton>
      <CaptionButton label={t("layout.window_close")} danger onClick={() => void getCurrentWindow().close()}>
        <X className="size-3.5" strokeWidth={1.5} />
      </CaptionButton>
    </div>
  );
}

function CaptionButton({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-tauri-drag-region={false}
      onClick={onClick}
      className={cn(
        "flex w-[46px] shrink-0 items-center justify-center transition-colors",
        danger
          ? "text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
