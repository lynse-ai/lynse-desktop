import type { Page } from "@playwright/test";
import { MOCK_FILES } from "../fixtures/api-mocks";
import { expect, openWorkspace, test } from "../fixtures/desktop-fixture";

const SUMMARY_PATH = "/api/summarize";
const INSERT_PATH = "/api/business/file/conclusion/insert";
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const MARKDOWN_TAB = "Lynclaw summary · Markdown";
const HTML_TAB = "Lynclaw summary · HTML";
const transcript = "We reviewed the milestones for the launch. Please confirm the delivery date and share the updated release plan with the operations team.";
const markdown = `## Markdown recap\n\nThe team agreed to <mark>confirm the delivery date</mark>.\n\n![Milestone photo](${PNG})`;
const html = `<!DOCTYPE html><html><head><style>mark{color:purple}</style></head><body>`
  + `<main><h2>HTML recap</h2><p>The team agreed to <mark>confirm the delivery date</mark>.</p>`
  + `<img alt="Milestone photo" src="${PNG}"></main></body></html>`;

async function openNotes(page: Page) {
  await page.getByRole("complementary").getByRole("button", { name: "Notes", exact: true }).click();
}

/** Add a Lynclaw summary via the beta pseudo-template in the add-summary dialog. */
async function addLynclawSummary(page: Page, format: "Markdown" | "HTML") {
  await page.getByRole("button", { name: "Add summary", exact: true }).click();
  // The card's accessible name leads with the MD/HTML format badge.
  const card = page.getByRole("button", { name: new RegExp(`Lynclaw summary · ${format}`) });
  await expect(card).toBeVisible();
  await expect(card.getByText("Beta", { exact: true })).toBeVisible();
  await card.click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
}

function lynclawConclusion(id: string, format: "markdown" | "html", body: string) {
  return {
    id,
    fileId: "file-q3-review",
    conclusionText: `<!-- lynclaw-summary:${format} -->\n\n${body}`,
    templateName: "",
    createdAt: "2026-09-01T11:05:00Z",
  };
}

async function expectSummaryTab(page: Page, format: "Markdown" | "HTML") {
  await expect(page.getByRole("button", { name: `Lynclaw summary · ${format}`, exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: `${format} recap`, exact: true })).toBeVisible();
  await expect(page.locator("mark").getByText("confirm the delivery date", { exact: true })).toBeVisible();
  const photo = page.getByRole("img", { name: "Milestone photo" });
  await expect(photo).toHaveAttribute("src", PNG);
  await expect.poll(() => photo.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
}

test("beta lynclaw templates summarize the transcript into persisted summary tabs", async ({ page, mockServer }) => {
  const [recording] = MOCK_FILES;
  const fileId = recording.id;
  const mark = { timeoffset: 2_000, title: "Milestone", outline: "Confirm the delivery date" };
  const signedUrl = `${mockServer.url}/mock-assets/visual-summary.png`;
  const baseConclusions = [
    {
      id: "conclusion-original", fileId, conclusionText: "Existing template summary",
      templateName: "Review", createdAt: "2026-09-01T11:00:00Z",
    },
    {
      id: "legacy-lynclaw", fileId,
      conclusionText: "<!-- lynclaw-summary:markdown -->\n\nAn earlier Lynclaw recap",
      createdAt: "2026-09-01T11:01:00Z",
    },
  ];
  mockServer.setRoute("GET /api/business/file/info", { body: {
    ...recording,
    recordStartTime: "2026-09-01 18:00:00",
    recordMarkResults: [mark],
    markImages: [{ imageId: "photo-milestone", timestamp: Date.parse("2026-09-01T10:00:03Z") }],
  } });
  mockServer.setRoute("GET /api/business/file/mark/image/presign/download", { body: signedUrl });
  mockServer.setRoute("GET /api/business/file/trans/get", { body: {
    fileId,
    transcriptionRecords: [{ beginTime: 2_000, endTime: 8_000, speakerName: "Lina", recognizedText: transcript }],
  } });
  mockServer.setRoute("GET /api/business/file/conclusion/list", { body: baseConclusions });
  mockServer.setRoute(`POST ${SUMMARY_PATH}`, { body: { title: "Generated title", content: markdown } });
  mockServer.setRoute(`POST ${INSERT_PATH}`, { body: "conclusion-lynclaw-1" });

  await openWorkspace(page, mockServer.url);
  await openNotes(page);
  const source = page.getByRole("button", { name: /Q3 review\.m4a quarterly/ });
  await source.click();
  await expect(page.getByRole("button", { name: "Review", exact: true })).toBeVisible();

  // An existing Lynclaw-encoded conclusion renders as a named summary tab.
  await page.getByRole("button", { name: MARKDOWN_TAB, exact: true }).first().click();
  await expect(page.getByText("An earlier Lynclaw recap", { exact: true })).toBeVisible();

  // Beta template: generate a Markdown summary from the transcript.
  await addLynclawSummary(page, "Markdown");
  await expectSummaryTab(page, "Markdown");
  expect(mockServer.lastRequest({ method: "POST", path: SUMMARY_PATH })?.body).toMatchObject({
    html: false,
    transcription_text: expect.stringContaining("[00:00:02.000-00:00:08.000] Lina:"),
    recording_started_at: "2026-09-01T10:00:00.000Z",
    recordMarkResults: [mark],
    markImages: [{ imageId: "photo-milestone", url: signedUrl }],
  });
  // The result is inserted as a real cloud conclusion — no AI task involved.
  const insert = mockServer.lastRequest({ method: "POST", path: INSERT_PATH });
  expect(insert?.body).toMatchObject({
    fileId,
    conclusionText: expect.stringContaining("<!-- lynclaw-summary:markdown -->"),
  });
  expect(mockServer.requests({ method: "POST", path: "/api/business/file/ai" })).toHaveLength(0);

  // The insert landed server-side: reflect it in the list like production would.
  const insertedMarkdown = lynclawConclusion("conclusion-lynclaw-1", "markdown", markdown.replace("## Markdown recap\n\n", ""));
  mockServer.setRoute("GET /api/business/file/conclusion/list", { body: [...baseConclusions, insertedMarkdown] });

  // HTML variant: degraded rendering surfaces the error and the tab sits in
  // its retry state until a retry succeeds.
  mockServer.setRoute(`POST ${SUMMARY_PATH}`, { body: { title: "Generated title", content: markdown, html_error: "unavailable" } });
  mockServer.setRoute(`POST ${INSERT_PATH}`, { body: "conclusion-lynclaw-2" });
  await addLynclawSummary(page, "HTML");
  await expect(page.getByText("Could not generate the HTML summary. Please try again.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "HTML recap", exact: true })).toHaveCount(0);

  mockServer.setRoute(`POST ${SUMMARY_PATH}`, { body: { title: "Generated title", content: markdown, html } });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.getByRole("button", { name: /Lynclaw summary · HTML/ }).click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expectSummaryTab(page, "HTML");
  expect(mockServer.lastRequest({ method: "POST", path: SUMMARY_PATH })?.body.html).toBe(true);
  expect(mockServer.lastRequest({ method: "POST", path: INSERT_PATH })?.body).toMatchObject({
    conclusionText: expect.stringContaining("<!-- lynclaw-summary:html -->"),
  });

  // Inserted conclusions are server rows — they survive a full reload.
  const insertedHtml = lynclawConclusion("conclusion-lynclaw-2", "html", html);
  mockServer.setRoute("GET /api/business/file/conclusion/list", {
    body: [...baseConclusions, insertedMarkdown, insertedHtml],
  });
  await page.goto("/");
  await openNotes(page);
  await source.click();
  await expect(page.getByRole("button", { name: MARKDOWN_TAB, exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: HTML_TAB, exact: true }).click();
  await expect(page.getByRole("heading", { name: "HTML recap", exact: true })).toBeVisible();

  // Deleting a lynclaw tab deletes the conclusion behind it.
  await page.getByRole("button", { name: HTML_TAB, exact: true }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete summary" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(mockServer.lastRequest({ method: "DELETE", path: "/api/business/file/conclusion/conclusion-lynclaw-2" })).toBeDefined();
  await expect(page.getByRole("button", { name: HTML_TAB, exact: true })).toHaveCount(0);
});
