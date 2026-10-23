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
  delete (window as Window & { desktopAPI?: unknown }).desktopAPI;
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

  it("zooms the opened image with the magnifier buttons, wheel, and keyboard, and resets to fit", () => {
    render(
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

    fireEvent.click(screen.getByRole("img", { name: "灵光记图文总结.png" }));

    const level = screen.getByTestId("chat-image-zoom-level");
    expect(level.textContent).toBe("100%");

    // Windows-Photos style magnifier buttons step in and out.
    fireEvent.click(screen.getByTestId("chat-image-zoom-in"));
    expect(level.textContent).toBe("125%");

    // Wheel zooms too (mouse wheel on Windows, two-finger scroll on Mac).
    fireEvent.wheel(screen.getByTestId("chat-image-stage"), { deltaY: -120 });
    expect(level.textContent).toBe("163%");

    // Keyboard +/- zooms and the fit button restores the default size.
    fireEvent.keyDown(window, { key: "-" });
    expect(level.textContent).toBe("130%");
    fireEvent.click(screen.getByTestId("chat-image-zoom-reset"));
    expect(level.textContent).toBe("100%");

    // Zooming out floors at 25% and disables the zoom-out button.
    for (let i = 0; i < 10; i += 1) {
      fireEvent.click(screen.getByTestId("chat-image-zoom-out"));
    }
    expect(level.textContent).toBe("25%");
    expect(screen.getByTestId("chat-image-zoom-out").hasAttribute("disabled")).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("chat-image-zoom-level")).toBeNull();
  });

  it("saves downloads through the desktop bridge without the browser fetch fallback", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const save = vi.fn().mockResolvedValue({ path: "/Users/me/Downloads/card.png" });
    (window as Window & { desktopAPI?: unknown }).desktopAPI = {
      attachment: { save },
    };
    render(
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

    fireEvent.click(screen.getByRole("img", { name: "灵光记图文总结.png" }));
    fireEvent.click(screen.getByTestId("chat-image-download"));

    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        "https://files.example.com/card.png",
        "灵光记图文总结.png",
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not fall back to the web download when the save dialog is cancelled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const save = vi.fn().mockResolvedValue(null);
    (window as Window & { desktopAPI?: unknown }).desktopAPI = {
      attachment: { save },
    };
    render(
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

    fireEvent.click(screen.getByRole("img", { name: "灵光记图文总结.png" }));
    fireEvent.click(screen.getByTestId("chat-image-download"));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
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

  it("downloads HTML reports instead of previewing the signed url inline", () => {
    const { container } = render(
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

    // No iframe and no anchor: either would put the signed object host, key
    // and signature in the status bar or the address bar.
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("button", { name: /meeting-report\.html/ })).toBeTruthy();
  });

  it("names markdown attachments by their first heading and downloads instead of previewing", async () => {
    const body = "# 10-20 产品运营周会：录音卡产品运营与版本规划周会\n\n结论速览";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => body,
      blob: async () => new Blob([body], { type: "text/markdown" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:mock-body"),
      revokeObjectURL: vi.fn(),
    }));
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <ChatAttachments
        attachments={[
          {
            name: "summary.md",
            type: "file",
            url: "https://bucket.example.com/summary.md",
            downloadUrl: "https://bucket.example.com/summary.md",
          },
        ]}
      />,
    );

    // The generic server name is replaced by the document's own title…
    expect(await screen.findByRole("button", { name: /10-20 产品运营周会：录音卡产品运营与版本规划周会\.md/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /summary\.md/ })).toBeNull();

    // …and tapping the card saves the file (no preview dialog, no eye icon).
    // The download anchor is removed right after its programmatic click, so
    // capture it through the click itself.
    const clicked: HTMLAnchorElement[] = [];
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicked.push(this);
      });
    fireEvent.click(screen.getByRole("button", { name: /10-20 产品运营周会：录音卡产品运营与版本规划周会\.md/ }));
    await waitFor(() => expect(clicked.length).toBeGreaterThan(0));
    expect(clicked[0]?.getAttribute("download")).toBe(
      "10-20 产品运营周会：录音卡产品运营与版本规划周会.md",
    );
    // Nothing in the DOM points at the object host.
    expect(document.querySelector("[href*='bucket.example.com']")).toBeNull();
    clickSpy.mockRestore();
    open.mockRestore();
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
    vi.unstubAllGlobals();
  });

  it("re-signs once and retries when the stored markdown url is already dead", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("expired"))
      .mockResolvedValueOnce({ ok: true, text: async () => "# 会议纪要\n\n正文" });
    vi.stubGlobal("fetch", fetchMock);
    refreshMock.mockResolvedValue("https://bucket.example.com/fresh.md");
    render(
      <ChatAttachments
        attachments={[
          {
            id: "c".repeat(32),
            name: "summary.md",
            type: "file",
            url: "https://bucket.example.com/stale.md",
            downloadUrl: "https://bucket.example.com/stale.md",
          },
        ]}
      />,
    );

    expect(await screen.findByRole("button", { name: /会议纪要\.md/ })).toBeTruthy();
    expect(refreshMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
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
