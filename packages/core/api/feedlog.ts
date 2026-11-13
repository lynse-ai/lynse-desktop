/**
 * Client for the self-hosted FeedLog suggestion board (feedback.lynse.ai):
 * feature feedback and request collection land there as public board posts.
 *
 * The webview cannot call FeedLog directly — the anonymous sign-in enforces
 * better-auth's same-host origin check, and /api/posts has no CORS headers —
 * so every call rides through a native-HTTP transport injected by the app
 * layer (the Rust `feedlog_api_request` command). Core stays
 * transport-agnostic: tests stub the transport; environments without one
 * fall back to opening the public board in a browser.
 */

/** The self-hosted FeedLog workspace (Cloudflare, custom domain). */
export const FEEDLOG_BASE_URL = "https://feedback.lynse.ai";

/** Board-name matcher for the seed board feature suggestions land in
 * (created by FeedLog's 0003_seed_defaults migration). */
export const FEEDLOG_FEATURE_BOARD_HINT = /^feature/i;

export interface FeedlogTransportRequest {
  baseUrl: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  bearer?: string | null;
}

export type FeedlogTransport = (
  req: FeedlogTransportRequest,
) => Promise<{ status: number; body: unknown }>;

export interface FeedlogBoard {
  id: string;
  name: string;
  description: string | null;
  position: number;
  postCount: number;
}

export interface FeedlogPostSummary {
  id: string;
  slug: string;
  title: string;
  status: string;
  voteCount: number;
  createdAt: string | null;
  unread?: boolean;
}

export interface FeedlogPostDetail {
  id: string;
  slug: string;
  title: string;
  content: string;
  status: string;
  boardId: string | null;
  voteCount: number;
}

export interface FeedlogCreatePostInput {
  title: string;
  content: string;
  boardId?: string | null;
}

async function feedlogFetch(
  transport: FeedlogTransport,
  req: FeedlogTransportRequest,
): Promise<{ status: number; json: unknown }> {
  const res = await transport(req);
  return { status: res.status, json: res.body ?? null };
}

/**
 * Mint an anonymous guest session (better-auth anonymous plugin). The raw
 * session token comes back in the body — the only place it is exposed, the
 * cookie is httpOnly. FeedLog renders guest authors as "Guest xxxx", a tag
 * derived from the guest's user id, so guests stay distinguishable without
 * carrying any account identity.
 */
export async function mintFeedlogGuestToken(
  baseUrl: string,
  transport: FeedlogTransport,
): Promise<string | null> {
  const { status, json } = await feedlogFetch(transport, {
    baseUrl,
    method: "POST",
    path: "/api/auth/sign-in/anonymous",
    body: {},
  });
  if (status !== 200) return null;
  const body = json as { token?: string | null; data?: { token?: string | null } } | null;
  return body?.token ?? body?.data?.token ?? null;
}

/** Public board list; posts are filed into one of these. */
export async function listFeedlogBoards(
  baseUrl: string,
  transport: FeedlogTransport,
): Promise<FeedlogBoard[]> {
  const { status, json } = await feedlogFetch(transport, {
    baseUrl,
    method: "GET",
    path: "/api/boards",
  });
  if (status !== 200) return [];
  const data = (json as { data?: FeedlogBoard[] } | null)?.data;
  return Array.isArray(data) ? data : [];
}

/**
 * Create a suggestion post. Any FeedLog session works — a real account or a
 * guest; the org's guest switch is enforced server-side. Returns the status
 * alongside the post so the caller can interpret 401 (expired guest session
 * → re-mint and retry) and 403 (guest posting disabled) itself.
 */
export async function createFeedlogPost(
  baseUrl: string,
  transport: FeedlogTransport,
  bearer: string,
  input: FeedlogCreatePostInput,
): Promise<{ status: number; post: FeedlogPostDetail | null }> {
  const { status, json } = await feedlogFetch(transport, {
    baseUrl,
    method: "POST",
    path: "/api/posts",
    body: { title: input.title, content: input.content, boardId: input.boardId ?? null },
    bearer,
  });
  if (status !== 201) return { status, post: null };
  const body = json as (FeedlogPostDetail & { data?: FeedlogPostDetail }) | null;
  const post = body?.id ? body : body?.data;
  return { status, post: post?.id ? post : null };
}

/** The caller's own posts (guest or SSO session), newest first. */
export async function listFeedlogMyPosts(
  baseUrl: string,
  transport: FeedlogTransport,
  bearer: string,
): Promise<FeedlogPostSummary[]> {
  const { status, json } = await feedlogFetch(transport, {
    baseUrl,
    method: "GET",
    path: "/api/widget/feedback?pageSize=50",
    bearer,
  });
  if (status !== 200) return [];
  const data = (json as { data?: FeedlogPostSummary[] } | null)?.data;
  return Array.isArray(data) ? data : [];
}

/** Public permalink for a suggestion post. */
export function feedlogPostUrl(slug: string): string {
  return `${FEEDLOG_BASE_URL}/p/${encodeURIComponent(slug)}`;
}
