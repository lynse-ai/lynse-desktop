import type { ChatAttachment, ChatMessage } from "./types";

/**
 * True when an assistant message carries nothing renderable at all. The poll
 * transport creates an empty assistant placeholder per turn; once the turn
 * resolves, such a placeholder is dropped so a cancelled turn never leaves a
 * dead bubble. A finished reply with an empty body is NOT empty, though —
 * the weekly-report PDF turn empties `text` server-side and speaks through
 * `attachments[]` alone — so any attachment / source / support link / confirm
 * card keeps the message alive.
 */
export function isEmptyAssistantPlaceholder(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    !message.content &&
    !message.workbuddyAuthRequired &&
    !message.attachments?.length &&
    !message.sources?.length &&
    !message.humanSupportLink?.url &&
    !message.confirm
  );
}

/** `![alt](url)` — the signed image URLs lynclaw inlines into reply bodies. */
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g;

/**
 * Remove `![alt](url)` images whose URL already rides in `attachments[]`.
 * lynclaw puts the signed image URL in both the body and the attachment list;
 * the attachment card is the canonical renderer (it can re-sign expired
 * URLs), so the body copy would show the same picture twice. Images with a
 * URL that is not among the attachments stay untouched.
 */
export function stripAttachmentDuplicateImages(
  content: string,
  attachments: ChatAttachment[] | undefined,
): string {
  if (!content || !attachments?.length) return content;
  const urls = new Set(
    attachments
      .flatMap((attachment) => [attachment.url, attachment.downloadUrl])
      .filter((url): url is string => !!url),
  );
  if (urls.size === 0) return content;
  return content
    .replace(MARKDOWN_IMAGE_RE, (match, _alt: string, url: string) =>
      urls.has(url) ? "" : match,
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
