// Lynse desktop "latest version" proxy.
//
// Why this exists: lynse-ai/lynse-desktop is a PRIVATE GitHub repo, so the
// desktop app cannot query the GitHub release API anonymously (it returns
// 404). This public endpoint queries the private release server-side using a
// GitHub token that only ever lives on the server and is never shipped to the
// client.
//
// Deploy (Cloudflare Workers):
//   wrangler secret put GITHUB_TOKEN   # a token with read access to private
//                                       # repos (no write/admin scopes needed)
//   wrangler deploy
// Mount at any path, e.g. /v1/client/latest-version.
//
// Response contract (matches what the desktop Rust command expects):
//   { "version": "0.1.27", "url": "...", "notes": "...", "publishedAt": "..." }

const REPO = "lynse-ai/lynse-desktop";

export default {
  async fetch(_request, env) {
    const token = env.GITHUB_TOKEN;
    if (!token) {
      return json({ message: "server misconfigured: missing GITHUB_TOKEN" }, 500);
    }

    const resp = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      {
        headers: {
          "User-Agent": "lynse-update-proxy",
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!resp.ok) {
      return json({ message: `GitHub error: ${resp.status}` }, 502);
    }

    const release = await resp.json();
    const data = {
      version: String(release.tag_name || "").replace(/^v/, ""),
      url: release.html_url || "",
      notes: release.body || "",
      publishedAt: release.published_at || "",
    };
    return json(data, 200, {
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    });
  },
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}
