/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatAttachments } from "./chat-attachments";

const refreshMock = vi.hoisted(() => vi.fn());

vi.mock("../workspace/chat-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace/chat-transport")>();
  return { ...actual, refreshAttachmentUrl: (...args: unknown[]) => refreshMock(...args) };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ChatAttachments", () => {
  it("shows cached images inline", () => {
    render(
      <ChatAttachments
        attachments={[
          {
            id: "file_image",
            name: "meeting-card.png",
            type: "image",
            url: "https://files.example.com/file_image.png",
          },
        ]}
      />,
    );

    expect(screen.getByRole("img", { name: "meeting-card.png" }).getAttribute("src")).toBe(
      "https://files.example.com/file_image.png",
    );
  });

  it("renders the bare image without card chrome and opens the viewer on click", () => {
    const { container } = render(
      <ChatAttachments
        attachments={[
          {
            id: "a".repeat(32),
            name: "灵光记图文总结.png",
            type: "image",
            url: "https://files.example.com/card.png",
          },
        ]}
      />,
    );

    // No figure/caption container — the bare picture is the attachment.
    expect(container.querySelector("figure")).toBeNull();
    expect(container.querySelector("figcaption")).toBeNull();

    fireEvent.click(screen.getByRole("img", { name: "灵光记图文总结.png" }));

    // Fullscreen viewer with download + forward actions.
    expect(screen.getByTestId("chat-image-download")).toBeTruthy();
    expect(screen.getByTestId("chat-image-forward")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Close"));
    expect(screen.queryByTestId("chat-image-download")).toBeNull();
  });

  it("renders pdf attachments as a plain file card without an inline preview and downloads on click", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const fetchMock = vi.fn().mockRejectedValue(new Error("cors"));
    vi.stubGlobal("fetch", fetchMock);
    refreshMock.mockResolvedValue("https://signed.example.com/fresh.pdf");
    const { container } = render(
      <ChatAttachments
        attachments={[
          {
            id: "b".repeat(32),
            name: "灵光记周报.pdf",
            type: "pdf",
            url: "https://signed.example.com/stale.pdf",
            downloadUrl: "https://signed.example.com/stale.pdf",
          },
        ]}
      />,
    );

    // WeChat-style file card: no iframe preview, just icon + filename.
    expect(container.querySelector("iframe")).toBeNull();
    const card = screen.getByRole("button", { name: /灵光记周报\.pdf/ });
    fireEvent.click(card);

    // Tap re-signs the artifact first, then downloads; when the fetch fails
    // (CORS) it falls back to opening the fresh URL.
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://signed.example.com/fresh.pdf", "_blank", "noopener,noreferrer"));
    open.mockRestore();
    vi.unstubAllGlobals();
  });

  it("shows cached HTML reports with a sandboxed preview and attachment link", () => {
    render(
      <ChatAttachments
        attachments={[
          {
            id: "file_html",
            name: "meeting-report.html",
            type: "html",
            url: "https://files.example.com/file_html.html",
            downloadUrl: "https://files.example.com/file_html.html",
          },
        ]}
      />,
    );

    const preview = screen.getByTitle("meeting-report.html");
    expect(preview.getAttribute("src")).toBe("https://files.example.com/file_html.html");
    expect(preview.getAttribute("sandbox")).toBe("");
    expect(
      screen.getByRole("link", { name: /meeting-report\.html/i }).getAttribute("href"),
    ).toBe("https://files.example.com/file_html.html");
  });

  it("re-signs and swaps the image source when the signed url fails to load", async () => {
    refreshMock.mockResolvedValue("https://signed.example.com/fresh.png");
    render(
      <ChatAttachments
        attachments={[
          {
            id: "a".repeat(32),
            name: "灵光记图文总结.png",
            type: "image",
            url: "https://signed.example.com/stale.png",
            downloadUrl: "https://signed.example.com/stale.png",
          },
        ]}
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: "灵光记图文总结.png" }));

    await waitFor(() =>
      expect(screen.getByRole("img", { name: "灵光记图文总结.png" }).getAttribute("src")).toBe(
        "https://signed.example.com/fresh.png",
      ),
    );
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("opens non-artifact attachments natively without a refresh attempt", () => {
    render(
      <ChatAttachments
        attachments={[
          { name: "local.pdf", type: "pdf", url: "https://files.example.com/local.pdf" },
        ]}
      />,
    );

    // Non-artifact file card: tap downloads straight from the cached url.
    fireEvent.click(screen.getByRole("button", { name: /local\.pdf/ }));

    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("mints a url on mount for url-less artifacts (lazy-signed backends, saved history)", async () => {
    refreshMock.mockResolvedValue("https://signed.example.com/minted.png");
    const { container } = render(
      <ChatAttachments
        attachments={[
          {
            id: "e".repeat(32),
            name: "灵光记图文总结-2026-09-02.png",
            type: "image",
            // lynclaw CloudBase 后端按对象路径懒签名：payload 里 download_url 为空
            downloadUrl: "",
          },
        ]}
      />,
    );

    // Nothing renders until the signed url arrives…
    expect(container.querySelector("img")).toBeNull();
    // …then the mount refresh fills it in.
    await waitFor(() =>
      expect(screen.getByRole("img", { name: "灵光记图文总结-2026-09-02.png" }).getAttribute("src")).toBe(
        "https://signed.example.com/minted.png",
      ),
    );
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("does not loop the mount refresh when re-signing fails", async () => {
    refreshMock.mockResolvedValue(null);
    const { container } = render(
      <ChatAttachments
        attachments={[
          { id: "f".repeat(32), name: "灵光记周报.pdf", type: "pdf", downloadUrl: "" },
        ]}
      />,
    );

    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    // Let effects re-run a few times; the attempt guard must keep it at one.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector("button")).toBeNull();
  });
});
