"use client";

/**
 * flomo-style share card for a note: title + date header, outline and summary
 * sections, brand footer. Rendered live inside the share dialog for preview
 * and mounted offscreen for PNG/PDF capture — same component, same output.
 *
 * Content typography (tables, headings, lists, code) is styled by the
 * injected <style> below against --sc-* variables from the card theme — NOT
 * the app's --border/--muted tokens, which would resolve to the viewer's
 * app theme and miscolor tables on themed cards.
 */
import { createRoot } from "react-dom/client";
import { Markdown } from "@lynse/ui/markdown/Markdown";
import { wrapCjkSpacing } from "../cjk-spacing";
import { isHtmlContent } from "../note-vault";
import { extractBody } from "../content-html";
import { stripMindmapContent } from "./share-export";
import "../content-preview.css";
import type { CSSProperties, ReactNode } from "react";
import type { ShareCardFontId, ShareCardTheme } from "./card-themes";

export interface ShareCardSection {
  id: string;
  /** Template name; already normalized ("auto" removed) by the caller. */
  name?: string | null;
  text: string;
}

export interface ShareCardProps {
  theme: ShareCardTheme;
  title: string;
  dateLabel: string;
  outlineLabel: string;
  summaryLabel: string;
  outlineText?: string | null;
  conclusions: ShareCardSection[];
  /** "约 N 字" stat for the footer, computed over the included content. */
  wordCountLabel?: string | null;
  /** "power by lynse.ai" signature line; off per the no-forced-branding principle. */
  showBrand?: boolean;
}

const CARD_WIDTH = 680;

/** Typeface per theme — macOS/Windows CJK stacks with graceful fallbacks. */
const CARD_FONT_FAMILIES: Record<ShareCardFontId, string> = {
  sans: "-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', sans-serif",
  serif: "'Songti SC', 'STSong', 'Noto Serif CJK SC', 'SimSun', Georgia, serif",
  kai: "'Kaiti SC', 'STKaiti', KaiTi, DFKai-SB, 'Noto Serif CJK SC', serif",
  round: "'Yuanti SC', 'STYuanti', YouYuan, 'Hiragino Maru Gothic ProN', 'PingFang SC', sans-serif",
};

/**
 * Card-scoped content styles. Tables are the critical part: the Markdown
 * component ships no table CSS (bare borderless tables) and
 * content-preview.css's table rules reference app-theme tokens plus a
 * 6.5em min column width that overflows the 584px card column.
 */
const CARD_CONTENT_CSS = `
.share-card-body { font-size: 15px; line-height: 1.75; }
.share-card-body h1, .share-card-body h2, .share-card-body h3,
.share-card-body h4, .share-card-body h5 { margin: 20px 0 8px; font-weight: 600; line-height: 1.5; }
.share-card-body h1 { font-size: 19px; }
.share-card-body h2 { font-size: 17px; }
.share-card-body h3 { font-size: 15.5px; }
.share-card-body h4, .share-card-body h5 { font-size: 15px; }
.share-card-body p { margin: 8px 0; }
.share-card-body ul, .share-card-body ol { margin: 8px 0; padding-left: 1.4em; }
.share-card-body li { margin: 4px 0; }
.share-card-body blockquote {
  margin: 10px 0; padding: 2px 0 2px 12px;
  border-left: 3px solid var(--sc-accent); color: var(--sc-muted);
}
.share-card-body a { color: var(--sc-accent); }
.share-card-body code {
  font-size: 13px; padding: 1px 5px; border-radius: 4px;
  background: color-mix(in srgb, var(--sc-fg) 7%, transparent);
}
.share-card-body pre {
  padding: 12px 14px; border-radius: 8px; overflow: hidden;
  background: color-mix(in srgb, var(--sc-fg) 7%, transparent);
}
.share-card-body pre code { padding: 0; background: transparent; }
.share-card-body hr { border: none; border-top: 1px solid var(--sc-border); margin: 16px 0; }

.share-card-body table {
  border-collapse: collapse; width: 100%; margin: 12px 0;
  table-layout: auto; font-variant-numeric: tabular-nums; display: table;
}
.share-card-body th, .share-card-body td {
  border: 1px solid var(--sc-border);
  padding: 7px 10px; text-align: left; font-size: 13px; line-height: 1.6;
  word-break: break-word; overflow-wrap: anywhere;
}
.share-card-body th {
  font-weight: 600;
  background: color-mix(in srgb, var(--sc-fg) 7%, transparent);
}
/* content-preview.css table rules use app-theme tokens and a 6.5em column
   floor that overflows the card column — re-skin them to the card theme. */
.share-card-body .content-preview-inner th,
.share-card-body .content-preview-inner td {
  border-color: var(--sc-border) !important;
  min-width: 0 !important;
  font-size: 13px;
}
.share-card-body .content-preview-inner th {
  background: color-mix(in srgb, var(--sc-fg) 7%, transparent) !important;
}
/* content-preview-inner sets color: var(--foreground) (app token) and a
   light 300 weight — both wrong for a themed share card. */
.share-card-body .content-preview-inner {
  color: inherit;
  font-weight: 400;
}
/* sspai-style highlight: accent-tinted marker behind kept text. */
.share-card-body mark,
.share-card-body .content-preview-inner mark {
  background: color-mix(in srgb, var(--sc-accent) 26%, transparent);
  color: inherit;
  padding: 0 2px;
  border-radius: 2px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
`;

function sectionHeading(label: string, theme: ShareCardTheme): ReactNode {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "28px 0 12px" }}>
      <span
        style={{
          width: 4,
          height: 16,
          borderRadius: 2,
          background: theme.accent,
          display: "inline-block",
        }}
      />
      <span style={{ fontSize: 16, fontWeight: 600, color: theme.foreground }}>{label}</span>
    </div>
  );
}

function SectionBody({ text }: { text: string }) {
  if (isHtmlContent(text)) {
    const { content, scopedStyles } = extractBody(text);
    return (
      <div>
        <style dangerouslySetInnerHTML={{ __html: scopedStyles }} />
        <div
          className="content-preview-inner"
          dangerouslySetInnerHTML={{ __html: wrapCjkSpacing(content) }}
        />
      </div>
    );
  }
  return <Markdown mode="minimal">{text}</Markdown>;
}

/**
 * The capture target is the outer wrapper: flat themes get an invisible
 * frame, gradient themes (aurora/sunset/ocean) show the gradient around the
 * inner card.
 */
export function ShareCard({ theme, title, dateLabel, outlineLabel, summaryLabel, outlineText, conclusions, wordCountLabel, showBrand = true }: ShareCardProps) {
  // Mind-map images never belong on the card; a section left empty by the
  // strip is dropped entirely, heading included.
  const hasOutline = !!stripMindmapContent(outlineText ?? "").trim();
  const outlineBodyText = hasOutline ? stripMindmapContent(outlineText!) : null;
  const sections = conclusions
    .map((section) => ({ ...section, text: stripMindmapContent(section.text) }))
    .filter((section) => section.text.trim());
  const hasFooter = showBrand || !!wordCountLabel;

  const cardStyle: CSSProperties = {
    width: CARD_WIDTH,
    boxSizing: "border-box",
    padding: 48,
    borderRadius: 20,
    background: theme.surface ?? theme.background,
    border: `1px solid ${theme.border}`,
    color: theme.foreground,
    fontFamily: CARD_FONT_FAMILIES[theme.font],
    fontSize: 15,
    lineHeight: 1.75,
    overflow: "hidden",
    // Theme-scoped tokens for the injected content styles above.
    ["--sc-fg" as string]: theme.foreground,
    ["--sc-muted" as string]: theme.muted,
    ["--sc-accent" as string]: theme.accent,
    ["--sc-border" as string]: theme.border,
  };

  return (
    <div style={{ background: theme.background, padding: 28, width: CARD_WIDTH + 56, boxSizing: "border-box" }}>
      <div style={cardStyle}>
        <style dangerouslySetInnerHTML={{ __html: CARD_CONTENT_CSS }} />
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, lineHeight: 1.4, color: theme.foreground }}>
          {title}
        </h1>
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: theme.muted }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: theme.accent,
              display: "inline-block",
              flexShrink: 0,
            }}
          />
          {dateLabel}
        </div>
        <div style={{ height: 1, background: theme.border, margin: "24px 0 4px" }} />
        <div className="share-card-body">
          {outlineBodyText && (
            <section>
              {sectionHeading(outlineLabel, theme)}
              <SectionBody text={outlineBodyText} />
            </section>
          )}
          {sections.map((section) => (
            <section key={section.id}>
              {sectionHeading(section.name?.trim() || summaryLabel, theme)}
              <SectionBody text={section.text} />
            </section>
          ))}
        </div>
        {hasFooter && (
          <>
            <div style={{ height: 1, background: theme.border, margin: "28px 0 14px" }} />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, fontSize: 12, color: theme.muted }}>
              {showBrand ? (
                <span style={{ display: "inline-flex", alignItems: "baseline", gap: 7 }}>
                  <span
                    style={{
                      fontStyle: "italic",
                      fontFamily: "'Snell Roundhand', 'Segoe Script', 'Brush Script MT', Georgia, serif",
                      fontSize: 13,
                      borderBottom: `2px solid ${theme.accent}`,
                      paddingBottom: 1,
                      lineHeight: 1.1,
                    }}
                  >
                    from
                  </span>
                  <span>lynse.ai</span>
                </span>
              ) : (
                <span />
              )}
              <span>{wordCountLabel ?? ""}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export interface OffscreenCard {
  element: HTMLElement;
  unmount: () => void;
}

/**
 * Render the card into a detached offscreen container for screenshotting.
 * Waits briefly for the React commit, web fonts and markdown rendering to
 * settle before the caller rasterizes.
 */
export async function mountShareCardOffscreen(props: ShareCardProps): Promise<OffscreenCard> {
  const host = document.createElement("div");
  host.setAttribute("data-share-card-host", "");
  Object.assign(host.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    zIndex: "-1",
    pointerEvents: "none",
  });
  document.body.append(host);
  const root = createRoot(host);
  root.render(<ShareCard {...props} />);
  // Let React commit and markdown/HTML rendering settle before capture.
  await new Promise((resolve) => setTimeout(resolve, 150));
  try {
    await Promise.race([
      document.fonts?.ready ?? Promise.resolve(),
      new Promise((resolve) => setTimeout(resolve, 600)),
    ]);
  } catch {
    // Font loading is best-effort; capture regardless.
  }
  const element = host.firstElementChild as HTMLElement;
  return {
    element,
    unmount: () => {
      root.unmount();
      host.remove();
    },
  };
}
