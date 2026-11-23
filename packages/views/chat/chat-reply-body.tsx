import { memo } from "react";
import { StreamingMarkdown } from "@lynse/ui/markdown";
import { useTranslation } from "@lynse/core/i18n/react";
import { AlertCircle } from "../icons";
import { cn } from "@lynse/ui/lib/utils";
import type { ChatMessage } from "../workspace/types";

/** Preserve partial answers while making a failed turn explicit. */
export const ChatReplyBody = memo(function ChatReplyBody({ message, isStreaming, className }: {
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
    {content && <div className={cn("relative leading-relaxed select-text", className)}>
      <StreamingMarkdown content={content} isStreaming={isStreaming && !message.error} mode="minimal" />
      {isStreaming && !message.error && (
        <span
          className="inline-block size-2 rounded-full bg-primary animate-pulse ml-1 align-baseline ring-2 ring-primary/20"
          aria-hidden="true"
        />
      )}
    </div>}
    {message.error && <div role="alert" className="mt-2.5 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs leading-5 text-destructive">
      <AlertCircle className="size-4 shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("chat.reply_incomplete")}</p>
        {detail && <p className="mt-1 whitespace-pre-wrap break-words opacity-90">{detail}</p>}
      </div>
    </div>}
  </>;
});
