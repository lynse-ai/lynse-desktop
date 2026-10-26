import { api } from "./client";

export const SUMMARY_HTML_STYLES = ["editorial", "editorial-dark", "infographic", "document"] as const;
export type SummaryHtmlStyle = (typeof SUMMARY_HTML_STYLES)[number];

export interface SummarizeTranscriptInput {
  transcriptionText: string;
  /** YYYYMMDDHHmm — when the recording happened; anchors relative dates in the summary. */
  recordingTime?: string;
  language?: string;
  /** Also render the adaptive summary as a complete styled HTML document. */
  html?: boolean;
  style?: SummaryHtmlStyle;
}

export interface SummarizeTranscriptResult {
  title: string | null;
  /** Adaptive Markdown without the leading title line. */
  content: string;
  html?: string;
  style?: SummaryHtmlStyle;
  degraded?: boolean;
  /** Present when html was requested but rendering degraded to Markdown only. */
  html_error?: string;
}

/**
 * Adaptive summary of an already-transcribed recording, served by the agent
 * service under the current login token. HTML is optional presentation: a
 * failed rendering still returns the Markdown with `html_error` set.
 */
export async function summarizeTranscript(
  input: SummarizeTranscriptInput,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<SummarizeTranscriptResult> {
  const text = input.transcriptionText.trim();
  if (!text) throw new Error("Transcript is empty");
  const client = api();
  const html = input.html === true;
  const response = await client.post<Partial<SummarizeTranscriptResult>>(
    "/api/summarize",
    {
      transcription_text: text,
      ...(input.recordingTime ? { recording_time: input.recordingTime } : {}),
      ...(input.language ? { language: input.language } : {}),
      html,
      ...(html && input.style ? { style: input.style } : {}),
    },
    { baseUrl: client.getAgentBaseUrl() ?? client.getBaseUrl(), tokenOnly: true, sessionToken, signal },
  );
  if (typeof response?.content !== "string") throw new Error("Summary unavailable");
  return { ...response, title: response.title ?? null, content: response.content };
}
