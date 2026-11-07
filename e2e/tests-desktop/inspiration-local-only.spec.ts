import { expect, openWorkspace, test } from "../fixtures/desktop-fixture";

test("quick notes save and reopen while offline without starting cloud sync", async ({ page, mockServer }) => {
  await page.addInitScript(() => {
    type Hooks = { setCommand: (name: string, handler: (args: Record<string, unknown>) => unknown) => void };
    const notes: Record<string, unknown>[] = [];
    const cloudCalls: string[] = [];
    Object.defineProperty(window, "quickNoteCloudCalls", { value: cloudCalls });
    Object.defineProperty(window, "__LYNSE_E2E__", {
      configurable: true,
      set(hooks: Hooks) {
        Object.defineProperty(window, "__LYNSE_E2E__", { value: hooks, configurable: true });
        for (const name of ["bind", "unbind", "status", "sync"]) {
          hooks.setCommand(`inspiration_cloud_${name}`, () => { cloudCalls.push(name); });
        }
        hooks.setCommand("inspiration_list", () => notes.slice());
        hooks.setCommand("inspiration_save", ({ inspiration }) => {
          const timestamp = new Date().toISOString();
          const note = { ...(inspiration as object), id: "inspiration:fixture", createdAt: timestamp, updatedAt: timestamp };
          notes.push(note);
          return note;
        });
      },
    });
  });
  await openWorkspace(page, mockServer.url);

  const quickNotes = page.getByRole("complementary").getByRole("button", { name: "Quick Notes", exact: true });
  await page.context().setOffline(true);
  await quickNotes.click();
  await expect(page.getByRole("heading", { name: "Quick Notes", exact: true, level: 2 })).toBeVisible();
  await expect(page.getByText("On this device", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New entry", exact: true }).first().click();
  const note = "Remember this offline";
  await page.getByPlaceholder(/Capture a fleeting thought/).fill(note);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Quick note saved on this device", { exact: true })).toBeVisible();
  await expect(page.getByText(note, { exact: true })).toBeVisible();

  await page.getByRole("complementary").getByRole("button", { name: "Home", exact: true }).click();
  await quickNotes.click();
  await expect(page.getByText(note, { exact: true })).toBeVisible();
  await page.context().setOffline(false);
  expect(await page.evaluate(() => Reflect.get(window, "quickNoteCloudCalls"))).toEqual([]);
});
