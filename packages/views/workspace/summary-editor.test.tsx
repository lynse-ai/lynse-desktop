// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { serializerCtx, editorViewCtx } from "@milkdown/kit/core";
import { expect, it, vi } from "vitest";
import { SummaryMarkdownEditor } from "./summary-editor";

it("highlights recording notes and renders the embedded image without losing the saved Markdown", async () => {
  const note = "> <mark>Route &amp; handover</mark> · 00:02:05";
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=";
  const ready = vi.fn();
  const { container } = render(
    <SummaryMarkdownEditor content={"## Routes\n\n" + note + "\n\n![Map](" + image + ")"} onEditorReady={ready} />,
  );
  await waitFor(() => {
    expect(container.querySelector("mark")?.textContent).toBe("Route & handover");
    expect(container.querySelector("img")?.getAttribute("src")).toBe(image);
  });
  const editor = ready.mock.lastCall?.[0];
  const markdown = editor.action((ctx: import("@milkdown/kit/ctx").Ctx) =>
    ctx.get(serializerCtx)(ctx.get(editorViewCtx).state.doc));
  expect(markdown).toContain("<mark>");
  expect(markdown).toContain("</mark>");
  expect(markdown).toContain("](" + image + ")");
});
