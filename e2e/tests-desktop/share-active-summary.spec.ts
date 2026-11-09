import { MOCK_FILES } from "../fixtures/api-mocks";
import { expect, openWorkspace, test } from "../fixtures/desktop-fixture";

type SavedShare = { name: string; text: string };

test("exports only the active summary after switching tabs", async ({ page, mockServer }) => {
  const [recording] = MOCK_FILES;
  const first = "RSI synthetic summary alpha";
  const second = "RSI synthetic summary beta";
  mockServer.setRoute("GET /api/business/file/conclusion/list", { body: [
    {
      id: "rsi-summary-a",
      fileId: recording.id,
      conclusionText: first,
      templateName: "Review",
      createdAt: "2026-09-01T11:00:00Z",
    },
    {
      id: "rsi-summary-b",
      fileId: recording.id,
      conclusionText: `<!-- lynclaw-summary:markdown -->\n\n${second}`,
      createdAt: "2026-09-01T11:01:00Z",
    },
  ] });

  await openWorkspace(page, mockServer.url);
  await page.getByRole("complementary").getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByRole("button", { name: /Q3 review\.m4a quarterly/ }).click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByText(first, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Lynclaw summary · Markdown", exact: true }).click();
  await expect(page.getByText(second, { exact: true })).toBeVisible();

  const saved: SavedShare[] = [];
  await page.exposeFunction("captureSummaryShare", (share: SavedShare) => saved.push(share));
  await page.evaluate(() => {
    type ShareWindow = Window & {
      desktopAPI: {
        attachment: {
          saveBytes: (bytes: Uint8Array | number[], name: string) => Promise<{ path: string }>;
        };
      };
      captureSummaryShare: (share: SavedShare) => Promise<void>;
    };
    const shareWindow = window as unknown as ShareWindow;
    shareWindow.desktopAPI.attachment.saveBytes = async (bytes, name) => {
      await shareWindow.captureSummaryShare({ name, text: new TextDecoder().decode(new Uint8Array(bytes)) });
      return { path: name };
    };
  });

  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Share…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Share note" });
  await dialog.getByRole("button", { name: "Markdown", exact: true }).click();
  await dialog.getByRole("button", { name: "Save…", exact: true }).click();

  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0].name).toMatch(/\.md$/);
  expect(saved[0].text).toContain(second);
  expect(saved[0].text, "RSI_INACTIVE_SUMMARY_LEAK").not.toContain(first);
});
