import { test, expect, openWorkspace } from "../fixtures/desktop-fixture";

test("Windows report previews load JPEGs and recover from a failed image load", async ({ page, mockServer }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  });
  let jpeg = Buffer.alloc(0);
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "local-media.localhost") {
      if (decodeURIComponent(url.pathname).includes("report-2.jpg")) return route.abort();
      return route.fulfill({ contentType: "image/jpeg", body: jpeg });
    }
    return url.hostname === "localhost" || url.hostname === "127.0.0.1"
      ? route.continue() : route.abort();
  });
  await openWorkspace(page, mockServer.url);
  const dataUrl = await page.evaluate(async () => {
    const moduleUrl = "/node_modules/@tauri-apps/api/mocks.js";
    const { mockConvertFileSrc } = await import(moduleUrl);
    mockConvertFileSrc("windows");
    const hooks = (window as unknown as {
      __LYNSE_E2E__: { setCommand: (name: string, handler: () => unknown) => void };
    }).__LYNSE_E2E__;
    let captures = 0;
    hooks.setCommand("report_capture_main_screenshot", () => {
      const file = `report-${++captures}.jpg`;
      return {
        path: `C:\\Lynse\\inspirations\\staging\\${file}`,
        url: `local-media://localhost/${encodeURIComponent(`staging:${file}`)}`,
      };
    });
    hooks.setCommand("diagnostics_read_logs", () => ({ dir: "logs", tail: "", truncated: false, files: 0 }));
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#f5f5f5";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#222222";
    context.font = "32px sans-serif";
    context.fillText("Report screenshot preview", 48, 80);
    return canvas.toDataURL("image/jpeg", 0.85);
  });
  jpeg = Buffer.from(dataUrl.split(",")[1]!, "base64");
  expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

  await page.getByRole("button", { name: "E2", exact: true }).click();
  await page.getByRole("menuitem", { name: "Report an issue", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const image = dialog.getByRole("img", { name: "Screenshot", exact: true });
  await expect(image).toHaveAttribute("src", "http://local-media.localhost/staging%3Areport-1.jpg");
  await expect.poll(() => image.evaluate((element) => {
    const img = element as HTMLImageElement;
    return [img.naturalWidth, img.naturalHeight];
  })).toEqual([1280, 720]);
  await expect(dialog).toHaveCSS("opacity", "1");
  await page.screenshot({
    path: test.info().outputPath("report-preview.jpg"), type: "jpeg", quality: 85, animations: "disabled",
  });

  await dialog.getByRole("button", { name: "Retake", exact: true }).click();
  const retry = dialog.getByRole("button", { name: "Screenshot preview failed to load — click to retake", exact: true });
  await expect(retry).toBeVisible();
  await expect(image).toHaveCount(0);
  await retry.click();
  await expect(image).toHaveAttribute("src", "http://local-media.localhost/staging%3Areport-3.jpg");
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(1280);
});
