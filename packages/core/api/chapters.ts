import { api } from "./client";

/** One normalized transcript segment sent to the chapter engine. Ids are the
 *  record's own segment ids — the model echoes them back as chapter boundaries
 *  and never proposes timestamps itself. */
export interface ChapterUtterance {
  id: string;
  text: string;
  start_ms?: number | null;
  end_ms?: number | null;
  speaker?: string | null;
}

export interface GenerateChaptersInput {
  /** Playback-ordered utterances; the server keeps this order as truth. */
  utterances: ChapterUtterance[];
  language?: string;
  /** YYYYMMDDHHmm — reserved for the engine's date anchoring. */
  recordingTime?: string;
}

export interface GeneratedChapter {
  title: string;
  summary: string;
  keywords: string[];
  start_segment_id: string;
  end_segment_id: string;
  start_ms: number | null;
  end_ms: number | null;
}

export interface GenerateChaptersResult {
  model: string | null;
  promptVersion: string;
  chapters: GeneratedChapter[];
}

/** Raw agent-service payload (snake_case) before client-side normalization. */
interface ChaptersResponseRaw {
  model?: string | null;
  prompt_version?: string;
  chapters?: GeneratedChapter[];
}

/**
 * AI semantic chaptering served by the agent service under the current login
 * token. Mirrors summarizeTranscript's transport; the response is validated
 * again on the client (semantic-chapters.ts) before it reaches the UI.
 */
export async function generateChapters(
  input: GenerateChaptersInput,
  sessionToken: string,
  signal?: AbortSignal,
): Promise<GenerateChaptersResult> {
  if (!input.utterances.length) throw new Error("Transcript is empty");
  const client = api();
  const response = await client.post<ChaptersResponseRaw>(
    "/api/chapters/generate",
    {
      utterances: input.utterances,
      ...(input.language ? { language: input.language } : {}),
      ...(input.recordingTime ? { recording_time: input.recordingTime } : {}),
    },
    { baseUrl: client.getAgentBaseUrl() ?? client.getBaseUrl(), tokenOnly: true, sessionToken, signal },
  );
  if (!Array.isArray(response?.chapters)) throw new Error("Chapters unavailable");
  return {
    model: response.model ?? null,
    promptVersion: response.prompt_version ?? "",
    chapters: response.chapters,
  };
}
