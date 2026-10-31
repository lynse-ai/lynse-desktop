/**
 * Shared helpers for rendering backend HTML documents (outline/summary bodies)
 * inside a constrained container. Extracted from content-panel so the share
 * card renders the exact same markup.
 */

export function extractBody(html: string): { content: string; scopedStyles: string } {
  const styleBlocks: string[] = [];

  const headMatch = html.match(/<head[^>]*>([\s\S]*)<\/head>/i);
  if (headMatch?.[1]) {
    headMatch[1].replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
      styleBlocks.push(css);
      return "";
    });
  }

  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  let content = bodyMatch?.[1] ? bodyMatch[1].trim() : html;

  content = content.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
    styleBlocks.push(css);
    return "";
  });
  content = content.replace(/<link[^>]*rel=["']stylesheet["'][^>]*\/?>/gi, "");

  let scopedStyles = "";
  if (styleBlocks.length > 0) {
    const rawCss = styleBlocks.join("\n");
    scopedStyles = scopeCss(rawCss, ".content-preview-inner");
  }

  // Desktop override: neutralize mobile-first fixed widths from backend templates
  // Also strip borders/backgrounds that leaked from body/html scoping.
  // Inline margins stay centered so the reading column cap in content-preview.css holds.
  const desktopOverride = `
.content-preview-inner {
  border: none !important;
  background: transparent !important;
  padding: 0 !important;
  margin-block: 0 !important;
  margin-inline: auto !important;
}
.content-preview-inner > *,
.content-preview-inner * {
  max-width: 100% !important;
}
.content-preview-inner img {
  max-width: 100% !important;
  height: auto !important;
}
.content-preview-inner table {
  width: 100% !important;
  table-layout: auto !important;
}
`;
  scopedStyles += desktopOverride;

  return { content, scopedStyles };
}

function scopeCss(css: string, scope: string): string {
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const parts: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    while (i < cleaned.length && /\s/.test(cleaned[i] ?? "")) i++;
    if (i >= cleaned.length) break;
    if (cleaned[i] === "@") {
      const braceStart = cleaned.indexOf("{", i);
      if (braceStart === -1) break;
      let depth = 1;
      let j = braceStart + 1;
      while (j < cleaned.length && depth > 0) {
        if (cleaned[j] === "{") depth++;
        else if (cleaned[j] === "}") depth--;
        j++;
      }
      const atHeader = cleaned.slice(i, braceStart).trim();
      const atBody = cleaned.slice(braceStart + 1, j - 1);

      // Strip @page rules (page-specific styles should not leak)
      if (/^@page\b/i.test(atHeader)) {
        i = j;
        continue;
      }

      // Recursively scope selectors inside @media blocks
      if (/^@media\b/i.test(atHeader)) {
        const scopedInner = scopeCss(atBody, scope);
        parts.push(`${atHeader} { ${scopedInner} }`);
        i = j;
        continue;
      }

      // Pass through @keyframes, @supports, etc. as-is
      parts.push(cleaned.slice(i, j));
      i = j;
      continue;
    }
    const braceStart = cleaned.indexOf("{", i);
    if (braceStart === -1) break;
    const selectorStr = cleaned.slice(i, braceStart).trim();
    let depth = 1;
    let j = braceStart + 1;
    while (j < cleaned.length && depth > 0) {
      if (cleaned[j] === "{") depth++;
      else if (cleaned[j] === "}") depth--;
      j++;
    }
    const body = cleaned.slice(braceStart, j);
    const scopedSelectors = selectorStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        // Replace global selectors with scope
        if (/^(html|body|:root|\*)$/.test(s)) return scope;
        // Scope each selector
        return `${scope} ${s}`;
      })
      .join(", ");
    parts.push(`${scopedSelectors} ${body}`);
    i = j;
  }
  return parts.join("\n");
}
