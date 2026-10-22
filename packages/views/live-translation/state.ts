import type {
  CompletedLiveSession,
  LiveAudioSource,
  LiveTranslationEvent,
  LiveTranslationSnapshot,
} from "./types";

export interface LiveTranslationViewState extends LiveTranslationSnapshot {
  lastError?: string;
  lastErrorSource?: LiveAudioSource;
  completed?: CompletedLiveSession;
  streamStates: Partial<Record<LiveAudioSource, string>>;
  /** True while the sidecar's echo gate is withholding the mic feed because
   * it only contains a copy of the playing system audio. */
  micSuppressed: boolean;
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
    micSuppressed: false,
  };
}

export function reduceLiveTranslationEvent(
  current: LiveTranslationViewState,
  event: LiveTranslationEvent,
): LiveTranslationViewState {
  if (event.type === "state") {
    // A brand-new session must not inherit the previous one's per-stream
    // connection states (or echo-gate flag): stale "connected"/"error"
    // entries would mislabel the new session's still-dialing streams.
    const freshSession = event.snapshot.sessionId !== current.sessionId;
    if (!freshSession && (event.snapshot.sourceRevision ?? 0) < (current.sourceRevision ?? 0)) return current;
    return {
      ...current,
      ...event.snapshot,
      ...(freshSession ? { streamStates: {}, micSuppressed: false } : {}),
      lastError: event.snapshot.state === "recording" ? undefined : current.lastError,
      lastErrorSource: event.snapshot.state === "recording"
        ? undefined
        : current.lastErrorSource,
    };
  }
  if (event.type === "levels") {
    if ((event.sessionId && event.sessionId !== current.sessionId)
      || (event.sourceRevision != null && event.sourceRevision !== (current.sourceRevision ?? 0))) return current;
    const mic = current.audioSources?.includes("mic") === false ? 0 : event.mic;
    const system = current.audioSources?.includes("system") === false ? 0 : event.system;
    return {
      ...current,
      micLevel: mic,
      systemLevel: system,
      recordingLevel: event.recordingLevel,
      aecDegraded: event.aecDegraded ?? current.aecDegraded,
      elapsedMs: event.elapsedMs,
      micSuppressed: event.micSuppressed ?? current.micSuppressed,
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
    const streamStates = { ...current.streamStates, [event.source]: event.state };
    const connectionRecovered = current.lastErrorSource !== undefined
      && Object.values(streamStates).every((state) => state === "connected");
    return {
      ...current,
      lastError: connectionRecovered ? undefined : current.lastError,
      lastErrorSource: connectionRecovered ? undefined : current.lastErrorSource,
      streamStates,
    };
  }
  if (event.type === "error") {
    return {
      ...current,
      lastError: event.message,
      lastErrorSource: event.source,
    };
  }
  return { ...current, completed: event.session };
}

function compareSegments(left: { startMs: number; source: LiveAudioSource }, right: { startMs: number; source: LiveAudioSource }) {
  if (left.startMs !== right.startMs) return left.startMs - right.startMs;
  return left.source === "mic" && right.source === "system" ? -1 : 1;
}
