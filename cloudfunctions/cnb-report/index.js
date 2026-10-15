/**
 * cnb-report — hands the client the credentials to file problem reports as
 * issues on CNB.
 *
 * The CNB access token lives in this function's env config (CNB_TOKEN,
 * issue-write scope on CNB_REPO only) and never ships in the client build.
 * The CloudBase access gateway caps request bodies at ~64 KB, so report
 * payloads (multi-MB screenshots) cannot proxy through here — instead the
 * client fetches the channel credentials with a GET and talks to
 * api.cnb.cool directly.
 *
 * Contract:
 *   GET  → 200 { repo, token }   (channel credentials for the CNB flow)
 *   POST { title, body, screenshot? } → 201 { number, issueUrl }
 *   (POST remains for small text-only reports; screenshots must use the
 *    direct-to-CNB path above.)
 */

const CNB_API_BASE = "https://api.cnb.cool";
const CNB_WEB_BASE = "https://cnb.cool";

const CNB_REPO = process.env.CNB_REPO || "";
const CNB_TOKEN = process.env.CNB_TOKEN || "";

const MAX_TITLE = 200;
const MAX_BODY = 64 * 1024;
// SCF sync-invoke payload caps the whole request at ~6 MB; keep the base64
// screenshot slice under that with room for the text fields.
const MAX_SCREENSHOT_BASE64 = 6 * 1024 * 1024; // ~4.5 MB binary PNG

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
 * Upload one PNG as an issue image asset and return its markdown-ready
 * link: create an asset group with a single image slot, then PUT the bytes
 * to the presigned URL (no Authorization header rides along). On failure
 * the issue is still filed — the caller degrades to a note in the body.
 */
async function uploadScreenshot(base64Data, contentType) {
  const bytes = Buffer.from(base64Data, "base64");
  if (bytes.length === 0) throw new Error("screenshot is empty");
  const type = contentType || "image/png";
  const group = await cnb("POST", `/${CNB_REPO}/-/issues/asset-groups`, {
    image_assets: [
      {
        name: type === "image/png" ? "screenshot.png" : "screenshot.jpg",
        size: bytes.length,
        content_type: type,
      },
    ],
  });
  const upload = group && group.image_upload_urls && group.image_upload_urls[0];
  if (!upload || !upload.upload_url || !upload.asset_link) {
    throw new Error("CNB asset group returned no upload URL");
  }
  const put = await fetch(upload.upload_url, {
    method: "PUT",
    headers: { "Content-Type": contentType || "image/png" },
    body: bytes,
  });
  if (!put.ok) {
    throw new Error(`screenshot upload rejected: HTTP ${put.status}`);
  }
  return upload.asset_link;
}

exports.main = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }
  if (!CNB_REPO || !CNB_TOKEN) {
    return json(503, { error: "report channel is not configured (CNB_REPO/CNB_TOKEN missing)" });
  }
  // Credential fetch for the client-side direct-to-CNB flow.
  if (event.httpMethod === "GET") {
    return json(200, { repo: CNB_REPO, token: CNB_TOKEN });
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

  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  if (!title || title.length > MAX_TITLE) {
    return json(400, { error: "title missing or too long" });
  }
  if (!body || body.length > MAX_BODY) {
    return json(400, { error: "body missing or too large" });
  }
  const screenshot = payload.screenshot;
  const screenshotData =
    screenshot && typeof screenshot.data === "string" ? screenshot.data : null;
  if (screenshotData && screenshotData.length > MAX_SCREENSHOT_BASE64) {
    return json(413, { error: "screenshot too large" });
  }

  try {
    let fullBody = body;
    if (screenshotData) {
      try {
        const link = await uploadScreenshot(screenshotData, screenshot.contentType);
        fullBody = `${body}\n\n![screenshot](${link})\n`;
      } catch (error) {
        fullBody = `${body}\n\n> 截图上传失败 / screenshot upload failed: ${error.message}\n`;
      }
    }
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
};
