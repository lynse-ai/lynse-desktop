import type { LiveAudioSource } from "./types";

// ---------------------------------------------------------------------------
// Meeting auto-record: shared types, the built-in meeting-app catalog, the
// localStorage-backed config, and the pure decision logic the headless agent
// (`MeetingAutoRecordAgent`) applies to detector events. The Rust side owns
// the polling/debounce machinery; everything here is UI + policy.
// ---------------------------------------------------------------------------

/** localStorage key for the auto-record configuration (non-secret). */
export const MEETING_AUTO_RECORD_CONFIG_KEY = "lynse_auto_record_config";

/** A whitelisted meeting application. On macOS a running process matches by
 * bundle ID (or executable name for unbundled helpers); on Windows by
 * executable name. Either list may be empty — it only participates when
 * non-empty. */
export interface MeetingAppEntry {
  id: string;
  /** Display name; i18n key for built-in apps (see KNOWN_MEETING_APPS). */
  name: string;
  bundleIds: string[];
  processNames: string[];
}

/** Built-in catalog of meeting apps the detector knows how to spot.
 * Bundle IDs verified against the vendors' macOS builds; executable names
 * cover the Windows side. Users can extend the list with custom entries in
 * Settings (e.g. an in-house conferencing tool). */
export const KNOWN_MEETING_APPS: readonly MeetingAppEntry[] = [
  {
    id: "tencent-meeting",
    name: "auto_record.app_tencent_meeting",
    // The unified 4.x client reports HAL bundle `com.tencent.meeting` and
    // executable `TencentMeeting` (observed in the field, 2026-09-13); the
    // wemeetapp identifiers cover the legacy client.
    bundleIds: ["com.tencent.meeting", "com.tencent.wemeetapp", "com.tencent.wemeet"],
    processNames: ["tencentmeeting", "wemeetapp", "wemeet"],
  },
  {
    id: "feishu",
    name: "auto_record.app_feishu",
    // `com.electron.lark.iron` is the media helper that actually holds the
    // audio IO (observed in the field, 2026-09-14); the Rust matcher also
    // covers helper suffixes generically, this keeps Windows + docs explicit.
    bundleIds: ["com.electron.lark", "com.electron.lark.iron", "com.ss.lark"],
    processNames: ["feishu", "lark"],
  },
  {
    id: "dingtalk",
    name: "auto_record.app_dingtalk",
    bundleIds: ["com.alibaba.DingTalk"],
    processNames: ["dingtalk"],
  },
  {
    id: "zoom",
    name: "auto_record.app_zoom",
    bundleIds: ["us.zoom.xos"],
    processNames: ["zoom"],
  },
  {
    id: "otter",
    name: "auto_record.app_otter",
    bundleIds: ["com.otterlabs.otter", "ai.otter.desktop"],
    processNames: ["otter"],
  },
] as const;

/** Events pushed by the Rust detector (`meeting-detector-event`). */
export type MeetingDetectorEvent =
  | { type: "meeting_started"; appId: string | null; appName: string | null; detectedAt: string }
  | { type: "meeting_ended"; appId: string | null; appName: string | null; detectedAt: string; durationSecs: number };

/** Configuration mirrored to the Rust detector on startup and every change. */
export interface MeetingAutoRecordConfig {
  enabled: boolean;
  /** Enabled subset of KNOWN_MEETING_APPS ids. */
  appIds: string[];
  /** User-defined extra apps (in-house tools, regional apps, …). */
  customApps: MeetingAppEntry[];
  /** Signal persistence required before a meeting is confirmed (seconds). */
  startDebounceSecs: number;
  /** Silence tolerated inside a meeting before it ends (seconds). */
  endGraceSecs: number;
}

export const DEFAULT_START_DEBOUNCE_SECS = 15;
export const DEFAULT_END_GRACE_SECS = 90;

export function defaultMeetingAutoRecordConfig(): MeetingAutoRecordConfig {
  return {
    enabled: false,
    appIds: KNOWN_MEETING_APPS.map((app) => app.id),
    customApps: [],
    startDebounceSecs: DEFAULT_START_DEBOUNCE_SECS,
    endGraceSecs: DEFAULT_END_GRACE_SECS,
  };
}

/** Parse persisted config; anything unexpected falls back per-field so a
 * partially corrupt payload never silently disables the user's apps. */
export function parseMeetingAutoRecordConfig(raw: string | null): MeetingAutoRecordConfig {
  const fallback = defaultMeetingAutoRecordConfig();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<MeetingAutoRecordConfig>;
    return {
      enabled: parsed.enabled === true,
      appIds: Array.isArray(parsed.appIds)
        ? parsed.appIds.filter((id): id is string => typeof id === "string")
        : fallback.appIds,
      customApps: Array.isArray(parsed.customApps)
        ? parsed.customApps.filter(
            (app): app is MeetingAppEntry =>
              !!app && typeof app === "object" && typeof app.id === "string" && typeof app.name === "string",
          )
        : [],
      startDebounceSecs:
        typeof parsed.startDebounceSecs === "number" && parsed.startDebounceSecs >= 1
          ? Math.floor(parsed.startDebounceSecs)
          : fallback.startDebounceSecs,
      endGraceSecs:
        typeof parsed.endGraceSecs === "number" && parsed.endGraceSecs >= 1
          ? Math.floor(parsed.endGraceSecs)
          : fallback.endGraceSecs,
    };
  } catch {
    return fallback;
  }
}

export function loadMeetingAutoRecordConfig(): MeetingAutoRecordConfig {
  if (typeof window === "undefined") return defaultMeetingAutoRecordConfig();
  return parseMeetingAutoRecordConfig(window.localStorage.getItem(MEETING_AUTO_RECORD_CONFIG_KEY));
}

export function saveMeetingAutoRecordConfig(config: MeetingAutoRecordConfig): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(MEETING_AUTO_RECORD_CONFIG_KEY, JSON.stringify(config));
}

/** The full whitelist (enabled built-ins + custom apps) as the Rust
 * `DetectorConfig` expects it. Built-in names are resolved from their i18n
 * keys here so the detector events carry a human-readable fallback name. */
export function whitelistApps(
  config: MeetingAutoRecordConfig,
  resolveName: (i18nKey: string) => string,
): MeetingAppEntry[] {
  const known = KNOWN_MEETING_APPS.filter((app) => config.appIds.includes(app.id)).map((app) => ({
    ...app,
    name: resolveName(app.name),
  }));
  return [...known, ...config.customApps];
}

/** Payload shape of `meeting_detector_set_config` (mirrors the Rust struct). */
export interface DetectorConfigPayload {
  enabled: boolean;
  startDebounceSecs: number;
  endGraceSecs: number;
  apps: MeetingAppEntry[];
}

export function toDetectorConfigPayload(
  config: MeetingAutoRecordConfig,
  resolveName: (i18nKey: string) => string,
): DetectorConfigPayload {
  return {
    enabled: config.enabled,
    startDebounceSecs: config.startDebounceSecs,
    endGraceSecs: config.endGraceSecs,
    apps: whitelistApps(config, resolveName),
  };
}

/** Snapshot shape of `meeting_detector_get_state` (mirrors the Rust struct). */
export interface DetectorStatus {
  enabled: boolean;
  phase: "idle" | "starting" | "in_meeting";
  app: string | null;
  meetingStartedAt: string | null;
}

/** Desktop bridge surface for the meeting detector (tauri-bridge installs it;
 * absent on web). */
export interface DesktopMeetingDetectorApi {
  setConfig: (config: DetectorConfigPayload) => Promise<DetectorStatus>;
  getState: () => Promise<DetectorStatus>;
  onEvent: (callback: (event: MeetingDetectorEvent) => void) => Promise<() => void>;
}

export function getDesktopMeetingDetectorApi(): DesktopMeetingDetectorApi | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { desktopAPI?: { meetingDetector?: DesktopMeetingDetectorApi } })
    .desktopAPI?.meetingDetector ?? null;
}

/** Resolve an event's app display name: prefer the freshly-resolved catalog
 * name (language-accurate), fall back to the name the Rust side received
 * when the config was pushed, then to a generic label. */
export function resolveEventAppName(
  event: MeetingDetectorEvent,
  config: MeetingAutoRecordConfig,
  translate: (i18nKey: string) => string,
): string {
  const appId = event.appId;
  const known = appId ? KNOWN_MEETING_APPS.find((app) => app.id === appId) : undefined;
  if (known) return translate(known.name);
  const custom = appId ? config.customApps.find((app) => app.id === appId) : undefined;
  if (custom) return custom.name;
  return event.appName || translate("auto_record.generic_app_name");
}

/** What the agent should do for a detector event, given the live session
 * state. Pure so the policy is unit-testable.
 * - start only when enabled + no session is running;
 * - stop only the session this agent started (manual recordings survive the
 *   meeting ending; a session the user already stopped is not stopped again). */
export type AutoRecordAction = { action: "start" } | { action: "stop" } | { action: "none" };

export function decideAutoRecordAction(input: {
  event: MeetingDetectorEvent;
  enabled: boolean;
  currentSessionId: string | null | undefined;
  agentStartedSessionId: string | null;
}): AutoRecordAction {
  const { event, enabled, currentSessionId, agentStartedSessionId } = input;
  if (!enabled) return { action: "none" };
  if (event.type === "meeting_started") {
    // A session is already running (recording, paused, or winding down).
    if (currentSessionId) return { action: "none" };
    return { action: "start" };
  }
  if (agentStartedSessionId && currentSessionId === agentStartedSessionId) {
    return { action: "stop" };
  }
  // The agent's session was already stopped (by the user) — nothing to do.
  return { action: "none" };
}

/** Capture sources for an auto-started session, honouring the user's audio
 * source preference but degrading gracefully when permissions are missing:
 * - "system" dropped when the system-audio TCC grant is absent (recording
 *   something is better than nothing — the hint tells the user);
 * - `null` when the resulting set cannot capture anything the user granted,
 *   meaning the agent must skip this meeting. */
export function autoRecordAudioSources(
  audioSourceMode: "both" | "mic" | "system" | undefined,
  perms: { microphone: string; systemAudio: string; systemAudioRequired: boolean } | null,
): LiveAudioSource[] | null {
  let sources: LiveAudioSource[] =
    audioSourceMode === "mic" ? ["mic"] : audioSourceMode === "system" ? ["system"] : ["mic", "system"];
  if (!perms) return null;
  if (sources.includes("system") && perms.systemAudioRequired && perms.systemAudio !== "granted") {
    sources = sources.filter((source) => source !== "system");
  }
  if (sources.includes("mic") && perms.microphone !== "granted") return null;
  if (sources.length === 0) return null;
  return sources;
}
