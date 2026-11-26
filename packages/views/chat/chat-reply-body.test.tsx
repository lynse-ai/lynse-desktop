/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChatReplyBody } from "./chat-reply-body";
import { ToolActivity } from "./chat-reasoning";
vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@lynse/ui/markdown", () => ({ StreamingMarkdown: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div> }));
afterEach(cleanup);
describe("interrupted chat replies", () => {
  it("keeps answer Markdown outside the actual error alert", () => {
    render(<ChatReplyBody message={{ content: "**纪要**\n正文", error: true, errorMessage: "生成超时" }} isStreaming />);
    expect(screen.getByTestId("markdown").textContent).toBe("**纪要**\n正文");
    expect(screen.getByRole("alert").textContent).toContain("生成超时");
    expect(screen.getByRole("alert").textContent).not.toContain("纪要");
  });
  it("handles an old partial answer whose error cause was discarded", () => {
    render(<ChatReplyBody message={{ content: "**原回复**", error: true }} isStreaming={false} />);
    expect(screen.getByTestId("markdown").textContent).toBe("**原回复**");
    expect(screen.getByRole("alert").textContent).toBe("chat.reply_incomplete");
  });
  it("recognizes old error-only histories without rendering them as an answer", () => {
    render(<ChatReplyBody message={{ content: "Error: timeout", error: true }} isStreaming={false} />);
    expect(screen.queryByTestId("markdown")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("timeout");
  });
  it("marks failed tools without a success checkmark", () => {
    const { container } = render(<ToolActivity tools={[{ id: "visual", name: "生成图文", state: "error" }]} />);
    expect(screen.getByLabelText("chat.tool_failed").classList.contains("text-destructive")).toBe(true);
    expect(container.querySelector(".lucide-check")).toBeNull();
  });
  it("shows skill loads as reads and uses muted icons for normal tool activity", () => {
    const { container } = render(<ToolActivity tools={[
      { id: "read", name: "load_note_review_skill", state: "done" },
      { id: "stop", name: "kill_task", state: "done" },
    ]} />);
    expect(screen.getByText("chat.tool_read")).toBeTruthy();
    expect(screen.getByText("chat.tool_stop")).toBeTruthy();
    expect(container.querySelector(".lucide-file-search")?.classList.contains("text-muted-foreground")).toBe(true);
    expect(container.querySelector(".lucide-circle-stop")?.classList.contains("text-muted-foreground")).toBe(true);
  });
});
