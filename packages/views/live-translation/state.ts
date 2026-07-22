import type {
  CompletedLiveSession,
  LiveAudioSource,
  LiveTranslationEvent,
  LiveTranslationSnapshot,
} from "./types";

export interface LiveTranslationViewState extends LiveTranslationSnapshot {
  lastError?: string;
  completed?: CompletedLiveSession;
  streamStates: Partial<Record<LiveAudioSource, string>>;
}

export function initialLiveTranslationState(): LiveTranslationViewState {
  return {
    state: "idle",
    epoch: 0,
    elapsedMs: 0,
    micLevel: 0,
    systemLevel: 0,
    segments: [],
    streamStates: {},
  };
}

export function reduceLiveTranslationEvent(
  current: LiveTranslationViewState,
  event: LiveTranslationEvent,
): LiveTranslationViewState {
  if (event.type === "state") {
    return {
      ...current,
      ...event.snapshot,
      lastError: event.snapshot.state === "recording" ? undefined : current.lastError,
    };
  }
  if (event.type === "levels") {
    return {
      ...current,
      micLevel: event.mic,
      systemLevel: event.system,
      elapsedMs: event.elapsedMs,
    };
  }
  if (event.type === "segment") {
    const segments = [...current.segments];
    const index = segments.findIndex((segment) => segment.id === event.segment.id);
    if (index >= 0) segments[index] = event.segment;
    else segments.push(event.segment);
    segments.sort(compareSegments);
    return { ...current, segments };
  }
  if (event.type === "segments") {
    return { ...current, segments: [...event.segments].sort(compareSegments) };
  }
  if (event.type === "streamState") {
    return {
      ...current,
      streamStates: { ...current.streamStates, [event.source]: event.state },
    };
  }
  if (event.type === "error") {
    return { ...current, lastError: event.message };
  }
  return { ...current, completed: event.session };
}

function compareSegments(left: { startMs: number; source: LiveAudioSource }, right: { startMs: number; source: LiveAudioSource }) {
  if (left.startMs !== right.startMs) return left.startMs - right.startMs;
  return left.source === "mic" && right.source === "system" ? -1 : 1;
}
