/* @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatAttachments } from "./chat-attachments";

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

  it("shows cached PDFs with an embedded preview and attachment link", () => {
    render(
      <ChatAttachments
        attachments={[
          {
            id: "file_pdf",
            name: "monthly-report.pdf",
            type: "pdf",
            url: "https://files.example.com/file_pdf.pdf",
            downloadUrl: "https://files.example.com/file_pdf.pdf",
          },
        ]}
      />,
    );

    expect(screen.getByTitle("monthly-report.pdf").getAttribute("src")).toBe(
      "https://files.example.com/file_pdf.pdf",
    );
    expect(
      screen.getByRole("link", { name: /monthly-report\.pdf/i }).getAttribute("href"),
    ).toBe("https://files.example.com/file_pdf.pdf");
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
});
