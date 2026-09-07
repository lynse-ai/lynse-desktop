"use client";

/**
 * Inspiration (flomo-style quick notes) shared types.
 *
 * Records live in the desktop app's local JSON store
 * (`local-inspirations/index.json`); voice memos add a WAV file under
 * `inspirations/<uuid>/audio.wav` plus an async transcript produced by the
 * local STT pipeline.
 */

export type InspirationTranscriptStatus =
  /** Text-only inspiration (or a memo that never asked for transcription). */
  | "none"
  /** Transcription is running. */
  | "pending"
  /** `transcript` holds the recognized text. */
  | "completed"
  /** Transcription failed (`transcriptError` says why); retryable. */
  | "failed"
  /** No local STT model installed; retryable once a model is downloaded. */
  | "unavailable";

export type InspirationAudio = {
  /** File name relative to `inspirations/<uuid>/`, always `audio.wav` for now. */
  file: string;
  durationMs: number;
};

export type InspirationImage = {
  /** File name relative to `inspirations/<uuid>/` (e.g. `img-1.jpg`). */
  file: string;
  /** Pixel dimensions, when known — masonry uses them to reserve space. */
  width?: number;
  height?: number;
};

/** A staged (not yet saved) image attachment in the capture sheet. */
export type InspirationStagedImage = {
  /** Absolute path of the staged file; adopted into durable storage on save. */
  sourcePath: string;
  /** `local-media://` preview URL served by the desktop shell. */
  previewUrl: string;
  width?: number;
  height?: number;
};

export type InspirationRecord = {
  id: string;
  /** Raw note text, flomo-style with inline `#tag` markers. */
  text: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  /** Present for voice memos. */
  audio?: InspirationAudio | null;
  /** Saved image attachments, newest first. */
  images?: InspirationImage[];
  transcript?: string | null;
  transcriptStatus?: InspirationTranscriptStatus | null;
  transcriptError?: string | null;
};

/** Payload for `inspiration_save`. The backend fills id/timestamps. */
export type InspirationSaveInput = {
  id?: string;
  text: string;
  tags?: string[];
  /** Absolute path of a just-captured WAV to adopt into durable storage. */
  pendingAudioPath?: string;
  pendingAudioDurationMs?: number;
  /**
   * Keep-list of already-saved images for edits (files stay on disk); files
   * missing from this list are deleted. Omit on creation.
   */
  images?: Array<{ file: string }>;
  /** Staged image attachments to adopt into durable storage. */
  pendingImages?: Array<{ sourcePath: string; width?: number; height?: number }>;
};

export type InspirationVoiceSnapshot = {
  state: "idle" | "connecting" | "recording" | "stopping";
  captureId: string | null;
  elapsedMs: number;
  /** Mic level in 0..1. */
  level: number;
};

export type InspirationVoiceStopResult = {
  audioPath: string;
  durationMs: number;
};

export type InspirationVoiceEvent =
  | { type: "levels"; level: number; elapsedMs: number }
  | { type: "ready" }
  | { type: "error"; message: string };

/** Desktop-only bridge surface; the web app has no implementation (null). */
export interface DesktopInspirationApi {
  list: () => Promise<InspirationRecord[]>;
  save: (inspiration: InspirationSaveInput) => Promise<InspirationRecord>;
  delete: (id: string) => Promise<void>;
  transcribe: (id: string) => Promise<InspirationRecord>;
  getAudioUrl: (id: string) => Promise<string | null>;
  getImageUrl: (id: string, file: string) => Promise<string | null>;
  /** Open the native image picker; resolves absolute paths (empty = cancelled). */
  pickImages: () => Promise<string[]>;
  /** Copy an image's bytes into staging; returns path + preview URL. */
  stageImage: (data: Uint8Array) => Promise<{ path: string; url: string }>;
  /**
   * Stage the image currently on the system clipboard (macOS). Preferred over
   * `stageImage` for pastes: reading the pasteboard natively avoids pushing
   * multi-megabyte bytes through the webview IPC, which froze the app.
   */
  stageImageFromClipboard: () => Promise<{ path: string; url: string }>;
  /** Copy a picked image file into staging; returns path + preview URL. */
  stageImageFromPath: (path: string) => Promise<{ path: string; url: string }>;
  /** Trigger macOS Continuity Camera; the photo arrives as a paste event. */
  captureFromIPhone: () => Promise<void>;
  voiceStart: () => Promise<InspirationVoiceSnapshot>;
  voiceStop: () => Promise<InspirationVoiceStopResult>;
  voiceCancel: () => Promise<void>;
  voiceState: () => Promise<InspirationVoiceSnapshot>;
  /** Subscribe to `inspiration-voice-event`; returns an unlisten fn. */
  onVoiceEvent: (callback: (event: InspirationVoiceEvent) => void) => Promise<() => void>;
}
