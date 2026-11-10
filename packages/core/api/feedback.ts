import { api } from "./client";

/** Unified feedback center contract against the lynclaw /api/feedback/* gateway
 *  (Feishu Bitable as the ticket store). Same shape as runtime/feedback/api.py. */

export type FeedbackCategory = "bug" | "feature" | "usage" | "performance";
export type FeedbackSeverity = "P1-高" | "P2-中" | "P3-低";
export type FeedbackSender = "user" | "staff";

export interface FeedbackTicketSummary {
  ticket_id: string;
  title: string;
  type: string;
  status: string;
  created_at: number | null;
}

export interface FeedbackMessage {
  message_id: string;
  sender: FeedbackSender;
  content: string;
  created_at: number | null;
}

export interface FeedbackTicketDetail {
  ticket: {
    ticket_id: string;
    title: string;
    description: string;
    type: string;
    module: string;
    severity: string;
    status: string;
    screenshot_url: string;
    created_at: number | null;
  };
  messages: FeedbackMessage[];
}

export interface FeedbackEnvironment {
  app_version?: string;
  platform?: string;
  user_agent?: string;
}

export interface CreateFeedbackTicketInput {
  title: string;
  description: string;
  category: FeedbackCategory;
  module?: string;
  severity?: FeedbackSeverity;
  contact?: string;
  screenshot_url?: string;
  environment?: FeedbackEnvironment;
}

function feedbackBase(): string {
  const client = api();
  const base = client.getAgentBaseUrl() ?? client.getBaseUrl();
  if (!base) throw new Error("Feedback endpoint unavailable");
  return base;
}

/** Server returns {"error":{"code","message"}} on failure (lynclaw gateway envelope). */
async function feedbackFetch<T>(path: string, init: RequestInit & { sessionToken: string }, parse: (payload: unknown) => T): Promise<T> {
  const response = await fetch(`${feedbackBase()}${path}`, init);
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body: fall through to the status check below.
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    const message = error?.message || (payload as { detail?: string } | null)?.detail || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return parse(payload);
}

export async function createFeedbackTicket(
  input: CreateFeedbackTicketInput,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<{ ticket_id: string; status: string; created_at: number | null }> {
  return feedbackFetch("/api/feedback/ticket", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: sessionToken },
    body: JSON.stringify(input),
    sessionToken,
    signal,
  }, (payload) => {
    const ticket = (payload as { ticket_id?: string } | null);
    if (!ticket?.ticket_id) throw new Error("Malformed ticket response");
    return {
      ticket_id: ticket.ticket_id,
      status: (payload as { status?: string }).status ?? "",
      created_at: (payload as { created_at?: number | null }).created_at ?? null,
    };
  });
}

export async function listFeedbackTickets(
  sessionToken: string,
  signal?: AbortSignal,
): Promise<{ items: FeedbackTicketSummary[]; total: number }> {
  return feedbackFetch("/api/feedback/ticket?limit=100", {
    method: "GET",
    headers: { Authorization: sessionToken },
    sessionToken,
    signal,
  }, (payload) => {
    const list = (payload as { items?: FeedbackTicketSummary[]; total?: number } | null);
    return { items: Array.isArray(list?.items) ? list.items : [], total: list?.total ?? 0 };
  });
}

export async function getFeedbackTicket(
  ticketId: string,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<FeedbackTicketDetail> {
  return feedbackFetch(`/api/feedback/ticket/${encodeURIComponent(ticketId)}`, {
    method: "GET",
    headers: { Authorization: sessionToken },
    sessionToken,
    signal,
  }, (payload) => {
    const detail = (payload as FeedbackTicketDetail | null);
    if (!detail?.ticket?.ticket_id) throw new Error("Malformed ticket detail");
    return detail;
  });
}

export async function addFeedbackMessage(
  ticketId: string,
  content: string,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<FeedbackMessage> {
  return feedbackFetch(`/api/feedback/ticket/${encodeURIComponent(ticketId)}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: sessionToken },
    body: JSON.stringify({ content }),
    sessionToken,
    signal,
  }, (payload) => {
    const message = (payload as FeedbackMessage | null);
    if (!message?.message_id) throw new Error("Malformed message response");
    return message;
  });
}
