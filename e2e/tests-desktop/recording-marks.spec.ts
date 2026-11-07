import { resolve } from "node:path";
import { MOCK_FILES } from "../fixtures/api-mocks";
import { expect, openWorkspace, test } from "../fixtures/desktop-fixture";

test("recording marks stay with their file and an empty recording falls back to the transcript", async ({ page, mockServer }) => {
  const [marked, empty] = MOCK_FILES;
  const infoPath = "/api/business/file/info";
  const signPath = "/api/business/file/mark/image/presign/download";
  const privateUrl = `${mockServer.url}/recording-mark-private.svg`;
  const signedUrl = `${mockServer.url}/recording-mark-signed.svg`;
  mockServer.setRoute(`GET ${infoPath}`, { body: {
    ...marked,
    recordMarks: [2000, 40000],
    recordMarkResults: [{ timeoffset: 2000, title: "会议要点", outline: "确认交付日期" }],
    markImages: [{ imageId: "photo-1", timestamp: 1788400000000, url: privateUrl }],
  } });
  mockServer.setRoute(`GET ${signPath}`, { body: signedUrl });
  await page.route(privateUrl, (route) => route.fulfill({ status: 403 }));
  await page.route(signedUrl, (route) => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="teal"/></svg>',
  }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openWorkspace(page, mockServer.url);
  await page.getByRole("complementary").getByRole("button", { name: "Notes", exact: true }).click();
  await page.getByRole("button", { name: /Q3 review\.m4a/ }).click();
  await page.evaluate(async (url) => {
    await (await import(url)).changeLanguage("zh-Hans");
  }, `/@fs${resolve(__dirname, "../../packages/core/i18n/react.ts")}`);

  const transcript = page.getByRole("button", { name: "逐字稿", exact: true });
  const marks = page.getByRole("button", { name: "标记", exact: true });
  await expect(transcript).toBeVisible();
  await expect(marks).toBeVisible();
  expect(await marks.evaluate((element) => element.previousElementSibling?.textContent)).toBe("逐字稿");
  await marks.click();
  await expect(page.getByText("会议要点", { exact: true })).toBeVisible();
  await expect(page.getByText("确认交付日期", { exact: true })).toBeVisible();
  await expect(page.getByText("00:00:02", { exact: true })).toHaveCount(1);
  await expect(page.getByText("00:00:40", { exact: true })).toBeVisible();
  const photo = page.getByRole("img", { name: "标记图片" });
  await expect(photo).toHaveAttribute("src", signedUrl);
  await expect.poll(() => photo.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(80);
  expect(mockServer.requests({ path: signPath })).toHaveLength(1);

  mockServer.setRoute(`GET ${infoPath}`, { body: empty });
  await page.getByRole("button", { name: /project kickoff\.mp3/ }).click();
  await expect(transcript).toHaveAttribute("data-tab-active", "true");
  await expect(marks).toHaveCount(0);
  await expect(page.getByText("会议要点", { exact: true })).toHaveCount(0);
  await expect(photo).toHaveCount(0);
  expect(errors).toEqual([]);
});
