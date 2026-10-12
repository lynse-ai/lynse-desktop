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
    render(<ToolActivity tools={[{ id: "visual", name: "生成图文", state: "error" }]} />);
    expect(screen.getByLabelText("chat.tool_failed")).toBeTruthy();
    expect(document.querySelector(".text-success")).toBeNull();
  });
});
