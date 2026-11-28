/**
 * Lightweight, allocation-minimal repair for an actively streaming Markdown
 * block so users see formatted typography (bold, inline code, links, fenced
 * code blocks, tables) immediately rather than raw syntax symbols snapping
 * into place only when a closing token arrives.
 *
 * Designed to run ONLY on the last (active) block while `isStreaming === true`.
 */

const FENCE_OPEN_RE = /^([ \t]*)(`{3,}|~{3,})([^\n]*)$/;
const TABLE_HEADER_RE = /^[ \t]*\|.+\|[ \t]*$/;
const PARTIAL_SEPARATOR_RE = /^[ \t]*\|[\s|:-]*$/;

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

/**
 * If an active block starts with an unclosed fenced code block, append the
 * matching closing fence so ReactMarkdown and linkify-it treat it as a code
 * block from the very first line.
 */
function closeUnclosedCodeFence(block: string): string | null {
  const lines = block.split("\n");
  const openMatch = FENCE_OPEN_RE.exec(lines[0] ?? "");
  if (!openMatch) return null;

  const fence = openMatch[2]!;
  const fenceChar = fence[0]!;
  const fenceLen = fence.length;
  const closeRe = new RegExp(`^[ \\t]*${fenceChar}{${fenceLen},}[ \\t]*$`);

  for (let i = 1; i < lines.length; i += 1) {
    if (closeRe.test(lines[i] ?? "")) {
      return block; // Already closed
    }
  }

  // Only the opening fence line has arrived so far (e.g. "```ts"): wait for
  // at least a newline or emit an empty fenced block without leaking raw ```.
  if (lines.length === 1) {
    return `${block}\n${fence}`;
  }
  return `${block}\n${fence}`;
}

/**
 * If line 1 is a pipe table header and line 2 is an in-progress GFM separator
 * row (e.g. `| ---` before the remaining columns arrive), complete the
 * separator cells so the header renders as a table instead of flashing pipes.
 */
function completePartialTableSeparator(block: string): string | null {
  const lines = block.split("\n");
  if (lines.length !== 2) return null;
  const header = lines[0] ?? "";
  const sep = lines[1] ?? "";
  if (!TABLE_HEADER_RE.test(header) || !PARTIAL_SEPARATOR_RE.test(sep)) {
    return null;
  }
  // Already a valid GFM separator row — let remark-gfm handle it as-is.
  if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(sep)) {
    return null;
  }
  const cols = header
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|").length;
  if (cols < 1) return null;
  const completedSep = `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`;
  return `${header}\n${completedSep}`;
}

/**
 * Neutralize an incomplete trailing Markdown link (`[label](https://...`) or
 * image (`![alt](https://...`) so raw URLs and broken image icons never flash
 * mid-stream. Bracketed text without `](` is left alone because prose often
 * uses square brackets (e.g. `[注]`).
 */
function repairTrailingLinkOrImage(text: string): string {
  // Scan backwards for the last `](` on the final line (inline links cannot
  // span blank lines and rarely span newlines inside URLs).
  const lastNewline = text.lastIndexOf("\n");
  const lineStart = lastNewline + 1;
  const tail = text.slice(lineStart);

  // Skip if inside an unclosed inline code span on the last line.
  const backticks = (tail.match(/(?<!\\)`/g) ?? []).length;
  if (backticks % 2 === 1) return text;

  const markerIdx = tail.lastIndexOf("](");
  if (markerIdx === -1) return text;

  // If a closing `)` already appears after `](`, the link is complete.
  const afterParen = tail.slice(markerIdx + 2);
  if (afterParen.includes(")")) return text;

  // Find the matching opening `[` before `]`.
  let depth = 0;
  let openBracket = -1;
  for (let i = markerIdx; i >= 0; i -= 1) {
    if (isEscaped(tail, i)) continue;
    if (tail[i] === "]") depth += 1;
    else if (tail[i] === "[") {
      depth -= 1;
      if (depth === 0) {
        openBracket = i;
        break;
      }
    }
  }
  if (openBracket === -1) return text;

  const isImage = openBracket > 0 && tail[openBracket - 1] === "!" && !isEscaped(tail, openBracket - 1);
  const start = isImage ? openBracket - 1 : openBracket;
  const label = tail.slice(openBracket + 1, markerIdx);

  if (isImage) {
    // Suppress incomplete image until its URL closes to avoid a broken <img>.
    return text.slice(0, lineStart + start);
  }
  // Render link text with final link styling without leaking the partial URL.
  return `${text.slice(0, lineStart + start)}[${label}](#)`;
}

type InlineToken = "`" | "***" | "**" | "*" | "~~";

/**
 * Track open inline formatting delimiters (`code`, ***bold italic***, **bold**,
 * *italic*, ~~strike~~) in LIFO order and close any that remain open at the
 * end of the active streaming block.
 */
function closeUnclosedInlineTokens(text: string): string {
  const stack: Array<{ token: InlineToken; index: number }> = [];
  let inInlineCode = false;
  let codeFenceLen = 0;

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    // Skip escaped characters.
    if (ch === "\\" && i + 1 < text.length) {
      i += 2;
      continue;
    }

    // Inline code backtick runs.
    if (ch === "`") {
      let run = 1;
      while (i + run < text.length && text[i + run] === "`") run += 1;
      if (!inInlineCode) {
        inInlineCode = true;
        codeFenceLen = run;
        stack.push({ token: "`", index: i });
      } else if (run === codeFenceLen) {
        inInlineCode = false;
        codeFenceLen = 0;
        // Pop backtick entry (always at top while inside inline code).
        if (stack.length > 0 && stack[stack.length - 1]!.token === "`") {
          stack.pop();
        }
      }
      i += run;
      continue;
    }

    if (inInlineCode) {
      i += 1;
      continue;
    }

    // Skip list item bullets (`* ` at start of line) and horizontal rules (`---`, `***`).
    const atLineStart = i === 0 || text[i - 1] === "\n";
    if (atLineStart) {
      const lineEnd = text.indexOf("\n", i);
      const line = lineEnd === -1 ? text.slice(i) : text.slice(i, lineEnd);
      if (/^[ \t]*([*-][ \t]*){3,}$/.test(line)) {
        i = lineEnd === -1 ? text.length : lineEnd + 1;
        continue;
      }
      const bulletMatch = /^[ \t]*\*[ \t]+/.exec(line);
      if (bulletMatch) {
        i += bulletMatch[0].length;
        continue;
      }
    }

    // Strikethrough: ~~
    if (ch === "~" && text[i + 1] === "~") {
      const topIdx = findTop(stack, "~~");
      if (topIdx !== -1) {
        stack.splice(topIdx, 1);
      } else {
        stack.push({ token: "~~", index: i });
      }
      i += 2;
      continue;
    }

    // Emphasis: ***, **, *
    if (ch === "*") {
      let run = 1;
      while (i + run < text.length && text[i + run] === "*") run += 1;

      if (run >= 3) {
        const topIdx = findTop(stack, "***");
        if (topIdx !== -1) {
          stack.splice(topIdx, 1);
        } else {
          stack.push({ token: "***", index: i });
        }
        i += 3;
        continue;
      }
      if (run === 2) {
        const topIdx = findTop(stack, "**");
        if (topIdx !== -1) {
          stack.splice(topIdx, 1);
        } else {
          stack.push({ token: "**", index: i });
        }
        i += 2;
        continue;
      }

      // Single `*`: check if closing an open `*`, or half-typed closing `**` at end,
      // or opening a left-flanking italic span (`*word`).
      const topStar = findTop(stack, "*");
      if (topStar !== -1) {
        stack.splice(topStar, 1);
      } else if (i === text.length - 1 && (findTop(stack, "**") !== -1 || findTop(stack, "***") !== -1)) {
        // Trailing single `*` when `**`/`***` is open — let the post-loop finish it.
      } else if (i + 1 < text.length && !/\s/.test(text[i + 1]!)) {
        // Left-flanking `*` followed by non-whitespace.
        const prev = i > 0 ? text[i - 1]! : " ";
        if (!/[A-Za-z0-9]/.test(prev)) {
          stack.push({ token: "*", index: i });
        }
      }
      i += 1;
      continue;
    }

    i += 1;
  }

  if (stack.length === 0) return text;

  let result = text;
  // Close open delimiters in LIFO order.
  for (let s = stack.length - 1; s >= 0; s -= 1) {
    const entry = stack[s]!;
    const afterOpen = result.slice(entry.index + entry.token.length);

    // If the opening marker is sitting at the very end with nothing after it
    // yet (e.g. "这是 **" or "使用 `"), strip the dangling marker for this tick
    // so raw syntax symbols don't flash before the first character arrives.
    if (entry.index + entry.token.length === result.length) {
      result = result.slice(0, entry.index);
      continue;
    }

    // Half-typed closing delimiters at the very end (e.g. "**加粗*", "~~删除~").
    if (entry.token === "**" && result.endsWith("*") && !result.endsWith("**")) {
      result += "*";
      continue;
    }
    if (entry.token === "***") {
      if (result.endsWith("**") && !result.endsWith("***")) {
        result += "*";
        continue;
      }
      if (result.endsWith("*") && !result.endsWith("**")) {
        result += "**";
        continue;
      }
    }
    if (entry.token === "~~" && result.endsWith("~") && !result.endsWith("~~")) {
      result += "~";
      continue;
    }

    // Don't wrap pure whitespace (e.g. "**   ") in emphasis markers.
    if (entry.token !== "`" && !afterOpen.trim()) {
      continue;
    }

    if (entry.token === "`") {
      result += "`".repeat(codeFenceLen || 1);
    } else {
      result += entry.token;
    }
  }

  return result;
}

function findTop(
  stack: Array<{ token: InlineToken; index: number }>,
  token: InlineToken,
): number {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (stack[i]!.token === token) return i;
  }
  return -1;
}

/**
 * Complete incomplete Markdown syntax on the active trailing block while
 * streaming so headings, emphasis, inline code, links, tables, and fenced
 * code blocks render smoothly without flashing raw syntax characters.
 */
export function completeStreamingMarkdown(block: string): string {
  if (!block) return block;

  // 1. Fenced code block: ensure closing fence exists (don't touch code inside).
  const fenced = closeUnclosedCodeFence(block);
  if (fenced !== null) return fenced;

  // 2. Display math block (`$$`): leave unclosed math alone so KaTeX does not
  //    flash red ParseError spans on partial LaTeX expressions.
  if (block.trimStart().startsWith("$$")) return block;

  // 3. Partial GFM table separator line (`| h1 | h2 |\n| --`).
  const tableCompleted = completePartialTableSeparator(block);
  if (tableCompleted !== null) return tableCompleted;

  // 4. Trailing unclosed link / image + inline emphasis / code spans.
  let result = repairTrailingLinkOrImage(block);
  result = closeUnclosedInlineTokens(result);
  return result;
}
