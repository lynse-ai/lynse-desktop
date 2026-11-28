/**
 * Redact meeting identifiers from assistant replies.
 *
 * The desktop AI assistant streams answers from the cloud backend. Those
 * answers may include raw meeting identifiers — numeric snowflake IDs, mixed
 * alphanumeric IDs, UUIDs, lynse file IDs (underscore-separated), or values
 * after an explicit "ID / 会议ID / 编号" label.
 * End users find these noisy and unwanted, so we strip them from the
 * displayed text while keeping the assistant's wording and Markdown formatting
 * intact.
 *
 * Detection is deliberately conservative to avoid clobbering legitimate
 * content:
 *  - 16+ digit numeric runs             → almost certainly an ID, not a date/phone
 *  - 20+ char mixed letter+digit runs    → hash / snowflake style IDs
 *  - standard UUIDs (with hyphens)
 *  - Lynse file IDs: \d+_\d+_[A-Za-z0-9]+   (underscore-compound)
 *  - values following an "ID / 会议ID / 编号" label
 *
 * Fenced code blocks and Markdown links (including unclosed trailing ones while
 * streaming) are protected first so code indentation and URLs are never
 * corrupted. Non-matching inputs return verbatim with zero whitespace mutation.
 */

const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})/;
const MARKDOWN_LINK = /\[[^\]]*\]\([^)]*\)/g;
const STREAMING_UNCLOSED_LINK = /!?\[[^\]]*\]\([^)\n]*$/;
/** Lynse file ID pattern: e.g. 1993855667662958593_1782792055088_3n9y4w8t */
const LYNSE_FILE_ID = /\b\d{10,}_\d{10,}_[A-Za-z0-9]{4,}\b/g;
const ID_LABEL = /(?:会议ID|会议编号|ID|编号)[ \t]*[:：][ \t]*/;
const ID_VALUE = "[A-Za-z0-9_-]{4,}";
const LABELED_ID = new RegExp(String.raw`${ID_LABEL.source}${ID_VALUE}[ \t]*`, "gi");
const LABELED_ID_ON_NEXT_LINE = new RegExp(
  String.raw`^([ \t]*)${ID_LABEL.source}(\r?\n)([ \t]*)${ID_VALUE}[ \t]*(?=\r?$)`,
  "gim",
);
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const NUM_ID = /\b\d{16,}\b/g;
const MIXED_ID = /\b(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{20,}\b/g;

// Unicode private-use sentinels wrapping protected spans.
const OPEN = "\uE000";
const CLOSE = "\uE001";

export interface RedactMeetingIdsOptions {
  /**
   * True while incremental stream deltas are still arriving. Protects unclosed
   * Markdown link destinations at the tail and avoids trimming trailing spaces
   * on the active last line.
   */
  streaming?: boolean;
}

function isMatchingFenceClose(line: string, char: string, len: number): boolean {
  const trimmed = line.trim();
  if (trimmed.length < len) return false;
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] !== char) return false;
  }
  return true;
}

function protectFencedCodeBlocks(input: string, protect: (span: string) => string): string {
  if (!input.includes("```") && !input.includes("~~~")) return input;
  const lines = input.split("\n");
  const out: string[] = [];
  let fence: { char: string; len: number; lines: string[] } | null = null;

  for (const line of lines) {
    if (fence) {
      fence.lines.push(line);
      if (isMatchingFenceClose(line, fence.char, fence.len)) {
        out.push(protect(fence.lines.join("\n")));
        fence = null;
      }
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open?.[1]) {
      fence = { char: open[1][0]!, len: open[1].length, lines: [line] };
      continue;
    }
    out.push(line);
  }
  if (fence) {
    out.push(protect(fence.lines.join("\n")));
  }
  return out.join("\n");
}

function tidyRedactedLine(line: string, preserveTrailingSpace: boolean): string {
  const indentMatch = /^[ \t]*/.exec(line);
  const indent = indentMatch ? indentMatch[0] : "";
  let body = line.slice(indent.length);
  body = body
    .replace(/\([ \t]*\)|（[ \t]*）/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([）)])/g, "$1");
  if (!preserveTrailingSpace) {
    body = body.replace(/[ \t]+$/, "");
  }
  return indent + body;
}

export function redactMeetingIds(
  input: string,
  options: RedactMeetingIdsOptions = {},
): string {
  if (!input) return input;

  const { streaming = false } = options;
  const protectedSpans: string[] = [];
  const protect = (match: string): string => {
    protectedSpans.push(match);
    return `${OPEN}${protectedSpans.length - 1}${CLOSE}`;
  };

  // Protect fenced code blocks and Markdown links so code and functional URLs
  // containing numeric IDs are never modified.
  let text = protectFencedCodeBlocks(input, protect).replace(MARKDOWN_LINK, protect);
  if (streaming) {
    text = text.replace(STREAMING_UNCLOSED_LINK, protect);
  }

  const withoutSplitIds = text.replace(LABELED_ID_ON_NEXT_LINE, "$1$2$3");
  const lines = withoutSplitIds.split("\n");
  let anyChanged = withoutSplitIds !== text;

  for (let i = 0; i < lines.length; i += 1) {
    const original = lines[i]!;
    const redacted = original
      .replace(LABELED_ID, "")
      .replace(UUID, "")
      .replace(NUM_ID, "")
      .replace(MIXED_ID, "")
      .replace(LYNSE_FILE_ID, "");

    if (redacted !== original) {
      anyChanged = true;
      const isActiveTail = streaming && i === lines.length - 1 && /[ \t]$/.test(original);
      lines[i] = tidyRedactedLine(redacted, isActiveTail);
    }
  }

  // Fast path: when no identifier matched, return the original string verbatim
  // so Markdown newlines, blank lines, and indentation are untouched.
  if (!anyChanged) return input;

  text = lines.join("\n");

  // Restore protected spans.
  if (protectedSpans.length > 0) {
    text = text.replace(
      new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"),
      (_, i) => protectedSpans[Number(i)] ?? "",
    );
  }

  return text;
}
