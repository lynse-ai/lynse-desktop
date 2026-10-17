/**
 * cnb-report — files problem reports as CNB issues, server-side.
 *
 * The CNB access token lives in this function's env config (CNB_TOKEN,
 * issue-write scope on CNB_REPO only) and never leaves this function: the
 * client cannot create issues or asset groups on its own.
 *
 * The CloudBase access gateway caps request bodies at ~64 KB, so multi-MB
 * screenshots cannot ride in the report POST. Instead the client asks for an
 * upload slot, PUTs the bytes straight to CNB's presigned URL (no
 * Authorization header, no credentials involved), and references the asset
 * in its report; the function embeds the link when filing.
 *
 * Contract (everything is POST + JSON; GET is not part of the channel):
 *   { action: "upload", size, contentType }
 *       → 200 { uploadUrl, downloadUrl }   presigned CNB asset slot
 *   { title, body, screenshotUrl? }        (a body without `action` is a submit)
 *       → 201 { number, issueUrl }         issue filed by this function
 */

const CNB_API_BASE = "https://api.cnb.cool";
const CNB_WEB_BASE = "https://cnb.cool";

const CNB_REPO = process.env.CNB_REPO || "";
const CNB_TOKEN = process.env.CNB_TOKEN || "";

const MAX_TITLE = 200;
// Headroom under the ~64 KB gateway body cap.
const MAX_BODY = 48 * 1024;
const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024;
const SCREENSHOT_CONTENT_TYPES = new Set(["image/png", "image/jpeg"]);

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(statusCode, data) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(data) };
}

function readJsonBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf-8")
    : event.body;
  return JSON.parse(raw);
}

async function cnb(method, path, payload) {
  const response = await fetch(`${CNB_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${CNB_TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`CNB API ${response.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

/**
 * Reserve an issue image asset slot and hand back the presigned pair: the
 * client PUTs the bytes to `uploadUrl`, the filed issue references
 * `downloadUrl` (the repo-scoped URL that serves image bytes to anonymous
 * visitors — `asset_link` would serve an HTML page instead).
 */
async function prepareScreenshotUpload(payload) {
  const size = Number(payload.size);
  const contentType = payload.contentType || "image/jpeg";
  if (!Number.isInteger(size) || size <= 0 || size > MAX_SCREENSHOT_BYTES) {
    return json(400, { error: "screenshot size out of range" });
  }
  if (!SCREENSHOT_CONTENT_TYPES.has(contentType)) {
    return json(400, { error: "unsupported screenshot content type" });
  }
  try {
    const group = await cnb("POST", `/${CNB_REPO}/-/issues/asset-groups`, {
      image_assets: [
        {
          name: contentType === "image/png" ? "screenshot.png" : "screenshot.jpg",
          size,
          content_type: contentType,
        },
      ],
    });
    const upload = group && group.image_upload_urls && group.image_upload_urls[0];
    if (!upload || !upload.upload_url || !upload.download_url) {
      throw new Error("CNB asset group returned no upload URL");
    }
    return json(200, {
      uploadUrl: upload.upload_url,
      downloadUrl: upload.download_url,
    });
  } catch (error) {
    return json(502, { error: String((error && error.message) || error).slice(0, 400) });
  }
}

async function submitIssue(payload) {
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  if (!title || title.length > MAX_TITLE) {
    return json(400, { error: "title missing or too long" });
  }
  if (!body || body.length > MAX_BODY) {
    return json(400, { error: "body missing or too large" });
  }
  // The body itself is free text, so a strict origin check on screenshotUrl
  // adds nothing — just keep it a bounded https URL.
  let screenshotUrl = null;
  if (payload.screenshotUrl !== undefined) {
    if (
      typeof payload.screenshotUrl !== "string" ||
      !payload.screenshotUrl.startsWith("https://") ||
      payload.screenshotUrl.length > 2048
    ) {
      return json(400, { error: "invalid screenshotUrl" });
    }
    screenshotUrl = payload.screenshotUrl;
  }
  const fullBody = screenshotUrl
    ? `${body}\n\n![screenshot](${screenshotUrl})\n`
    : body;

  try {
    const issue = await cnb("POST", `/${CNB_REPO}/-/issues`, {
      title,
      body: fullBody,
    });
    // CNB returns the issue number as a string ("42").
    const number =
      typeof issue?.number === "number"
        ? issue.number
        : Number.parseInt(issue?.number, 10);
    if (!Number.isFinite(number)) {
      throw new Error("CNB issue response missing number");
    }
    return json(201, {
      number,
      issueUrl: `${CNB_WEB_BASE}/${CNB_REPO}/-/issues/${number}`,
    });
  } catch (error) {
    return json(502, { error: String((error && error.message) || error).slice(0, 400) });
  }
}

exports.main = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (!CNB_REPO || !CNB_TOKEN) {
    return json(503, { error: "report channel is not configured (CNB_REPO/CNB_TOKEN missing)" });
  }
  if (event.httpMethod !== "POST") {
    return json(405, { error: "method not allowed" });
  }

  let payload;
  try {
    payload = readJsonBody(event);
  } catch {
    return json(400, { error: "request body is not valid JSON" });
  }

  if (payload.action === "upload") {
    return prepareScreenshotUpload(payload);
  }
  return submitIssue(payload);
};
