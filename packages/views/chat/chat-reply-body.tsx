import { StreamingMarkdown } from "@lynse/ui/markdown";
import { useTranslation } from "@lynse/core/i18n/react";
import type { ChatMessage } from "../workspace/types";

/** Preserve partial answers while making a failed turn explicit. */
export function ChatReplyBody({ message, isStreaming, className }: {
  message: Pick<ChatMessage, "content" | "error" | "errorMessage">;
  isStreaming: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  // Older histories stored error-only copy inside content. Other legacy
  // failures may carry a partial answer whose actual error was discarded.
  const legacyError = message.error && !message.errorMessage && message.content.startsWith("Error: ");
  const content = legacyError ? "" : message.content;
  const detail = message.errorMessage || (legacyError ? message.content.slice(7) : "");
  return <>
    {content && <div className={className}>
      <StreamingMarkdown content={content} isStreaming={isStreaming && !message.error} mode="minimal" />
    </div>}
    {message.error && <div role="alert" className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm leading-6 text-destructive">
      <p>{t("chat.reply_incomplete")}</p>
      {detail && <p className="whitespace-pre-wrap break-words">{detail}</p>}
    </div>}
  </>;
}
