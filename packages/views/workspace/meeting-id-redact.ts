/**
 * Redact meeting identifiers from assistant replies.
 *
 * The desktop AI assistant streams answers from the cloud backend. Those
 * answers may include raw meeting identifiers — numeric snowflake IDs, mixed
 * alphanumeric IDs, UUIDs, lynse file IDs (underscore-separated), or values
 * after an explicit "ID / 会议ID / 编号" label.
 * End users find these noisy and unwanted, so we strip them from the
 * displayed text while keeping the assistant's wording intact.
 *
 * Detection is deliberately conservative to avoid clobbering legitimate
 * content:
 *  - 16+ digit numeric runs             → almost certainly an ID, not a date/phone
 *  - 20+ char mixed letter+digit runs    → hash / snowflake style IDs
 *  - standard UUIDs (with hyphens)
 *  - Lynse file IDs: \d+_\d+_[A-Za-z0-9]+   (underscore-compound)
 *  - values following an "ID / 会议ID / 编号" label
 *
 * Markdown links are protected first so their URLs are never corrupted.
 */

const MARKDOWN_LINK = /\[[^\]]*\]\([^)]*\)/g;
/** Lynse file ID pattern: e.g. 1993855667662958593_1782792055088_3n9y4w8t */
const LYNSE_FILE_ID = /\b\d{10,}_\d{10,}_[A-Za-z0-9]{4,}\b/g;
const LABELED_ID = /(?:会议ID|会议编号|ID|编号)\s*[:：]\s*[A-Za-z0-9_-]{4,}\s*/gi;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const NUM_ID = /\b\d{16,}\b/g;
const MIXED_ID = /\b(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{20,}\b/g;

// Unicode private-use sentinels wrapping protected links.
const OPEN = "";
const CLOSE = "";

export function redactMeetingIds(input: string): string {
  if (!input) return input;

  // Protect markdown links (e.g. [周会](https://.../meeting/1735...)) so we
  // never corrupt a functional URL that happens to contain digits.
  const links: string[] = [];
  let text = input.replace(MARKDOWN_LINK, (m) => {
    links.push(m);
    return `${OPEN}${links.length - 1}${CLOSE}`;
  });

  text = text
    .replace(LABELED_ID, "")
    .replace(UUID, "")
    .replace(NUM_ID, "")
    .replace(MIXED_ID, "")
    .replace(LYNSE_FILE_ID, "");

  // Tidy leftover empty parentheses and collapsed whitespace.
  text = text
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\s+([）)])/g, "$1")
    .replace(/\s+$/gm, "");

  // Restore protected links.
  text = text.replace(
    new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"),
    (_, i) => links[Number(i)] ?? "",
  );

  return text;
}
