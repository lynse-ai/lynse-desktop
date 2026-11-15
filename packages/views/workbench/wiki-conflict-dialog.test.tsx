/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WikiConflictDialog } from "./wiki-conflict-dialog";
import { workbenchLocales } from "./locales";

const { wiki } = vi.hoisted(() => ({ wiki: vi.fn() }));
vi.mock("./api", () => ({ getWorkbenchApi: () => ({ wiki }) }));
vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({
    t: (key: string) => workbenchLocales.en[key.replace("workbench.", "") as keyof typeof workbenchLocales.en] ?? key,
  }),
}));

afterEach(() => { cleanup(); wiki.mockReset(); });

it("keeps an edited merge draft when the cloud version changed and reloads both version checks", async () => {
  const preview = {
    localVersion: "device-A", cloudVersion: "device-B",
    local: { title: "Project", markdown: "Local paragraph" },
    cloud: { title: "Project", markdown: "Cloud paragraph" },
    suggestedMarkdown: "Local paragraph\nCloud paragraph", canMerge: true,
  };
  wiki.mockResolvedValueOnce({ syncConflict: preview })
    .mockResolvedValueOnce({ syncConflict: { ...preview, cloudVersion: "device-B-new" } });
  const resolve = vi.fn().mockRejectedValueOnce(new Error("A topic version changed")).mockResolvedValueOnce({});
  render(<WikiConflictDialog topicId="topic" resolve={resolve} />);

  fireEvent.click(screen.getByRole("button", { name: "Compare versions" }));
  const editor = await screen.findByRole("textbox", { name: "Merged Markdown" }) as HTMLTextAreaElement;
  expect(editor.value).toBe(preview.suggestedMarkdown);
  fireEvent.change(editor, { target: { value: "Reviewed merge" } });
  fireEvent.click(screen.getByRole("button", { name: "Publish merged page" }));
  expect(await screen.findByText("Error: A topic version changed")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Reload versions" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Publish merged page" }) as HTMLButtonElement).disabled).toBe(false));
  expect(editor.value).toBe("Reviewed merge");
  fireEvent.click(screen.getByRole("button", { name: "Publish merged page" }));
  await waitFor(() => expect(resolve).toHaveBeenLastCalledWith(expect.objectContaining({
    choice: "merge", markdown: "Reviewed merge", localVersion: "device-A", cloudVersion: "device-B-new",
  })));
});
