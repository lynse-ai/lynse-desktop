/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import {
  KNOWN_MEETING_APPS,
  MEETING_AUTO_RECORD_CONFIG_KEY,
  autoRecordAudioSources,
  decideAutoRecordAction,
  defaultMeetingAutoRecordConfig,
  parseMeetingAutoRecordConfig,
  toDetectorConfigPayload,
} from "./meeting-auto-record";
import type { MeetingDetectorEvent } from "./meeting-auto-record";

function startedEvent(appId = "zoom"): MeetingDetectorEvent {
  return {
    type: "meeting_started",
    appId,
    appName: "Zoom",
    detectedAt: "2026-09-09T10:00:00+00:00",
  };
}

function endedEvent(): MeetingDetectorEvent {
  return {
    type: "meeting_ended",
    appId: "zoom",
    appName: "Zoom",
    detectedAt: "2026-09-09T11:00:00+00:00",
    durationSecs: 3600,
  };
}

const granted = { microphone: "granted", systemAudio: "granted", systemAudioRequired: true };

afterEach(() => {
  window.localStorage.clear();
});

describe("decideAutoRecordAction", () => {
  it("starts a recording when enabled and no session is running", () => {
    expect(
      decideAutoRecordAction({
        event: startedEvent(),
        enabled: true,
        currentSessionId: null,
        agentStartedSessionId: null,
      }),
    ).toEqual({ action: "start" });
  });

  it("never starts while a session is already running", () => {
    expect(
      decideAutoRecordAction({
        event: startedEvent(),
        enabled: true,
        currentSessionId: "manual-1",
        agentStartedSessionId: null,
      }),
    ).toEqual({ action: "none" });
  });

  it("does nothing when disabled", () => {
    expect(
      decideAutoRecordAction({
        event: startedEvent(),
        enabled: false,
        currentSessionId: null,
        agentStartedSessionId: null,
      }),
    ).toEqual({ action: "none" });
  });

  it("stops only the session the agent itself started", () => {
    expect(
      decideAutoRecordAction({
        event: endedEvent(),
        enabled: true,
        currentSessionId: "auto-1",
        agentStartedSessionId: "auto-1",
      }),
    ).toEqual({ action: "stop" });
  });

  it("never stops a manually started session when the meeting ends", () => {
    expect(
      decideAutoRecordAction({
        event: endedEvent(),
        enabled: true,
        currentSessionId: "manual-1",
        agentStartedSessionId: null,
      }),
    ).toEqual({ action: "none" });
  });

  it("does not stop again after the user already stopped the auto session", () => {
    expect(
      decideAutoRecordAction({
        event: endedEvent(),
        enabled: true,
        currentSessionId: "manual-2",
        agentStartedSessionId: "auto-1",
      }),
    ).toEqual({ action: "none" });
  });
});

describe("autoRecordAudioSources", () => {
  it("keeps both sources when everything is granted", () => {
    expect(autoRecordAudioSources("both", granted)).toEqual(["mic", "system"]);
  });

  it("drops the system source when its permission is missing", () => {
    const perms = { ...granted, systemAudio: "denied" };
    expect(autoRecordAudioSources("both", perms)).toEqual(["mic"]);
  });

  it("keeps system-only when system audio is granted and not required", () => {
    const perms = { microphone: "denied", systemAudio: "granted", systemAudioRequired: false };
    expect(autoRecordAudioSources("system", perms)).toEqual(["system"]);
  });

  it("returns null when the microphone is not granted", () => {
    const perms = { ...granted, microphone: "denied" };
    expect(autoRecordAudioSources("both", perms)).toBeNull();
  });

  it("returns null when nothing captureable remains", () => {
    const perms = { microphone: "granted", systemAudio: "denied", systemAudioRequired: true };
    expect(autoRecordAudioSources("system", perms)).toBeNull();
  });

  it("returns null without a permission snapshot", () => {
    expect(autoRecordAudioSources("both", null)).toBeNull();
  });
});

describe("config parsing", () => {
  it("falls back to defaults for absent or corrupt payloads", () => {
    expect(parseMeetingAutoRecordConfig(null)).toEqual(defaultMeetingAutoRecordConfig());
    expect(parseMeetingAutoRecordConfig("not json")).toEqual(defaultMeetingAutoRecordConfig());
    expect(parseMeetingAutoRecordConfig('{"enabled":"yes"}')).toMatchObject({
      enabled: false,
      startDebounceSecs: 15,
      endGraceSecs: 90,
    });
  });

  it("round-trips through localStorage", () => {
    const config = {
      ...defaultMeetingAutoRecordConfig(),
      enabled: true,
      appIds: ["zoom"],
      customApps: [{ id: "custom:1", name: "Internal", bundleIds: ["com.internal.meet"], processNames: [] }],
      startDebounceSecs: 30,
      endGraceSecs: 60,
    };
    window.localStorage.setItem(MEETING_AUTO_RECORD_CONFIG_KEY, JSON.stringify(config));
    expect(parseMeetingAutoRecordConfig(window.localStorage.getItem(MEETING_AUTO_RECORD_CONFIG_KEY))).toEqual(config);
  });
});

describe("detector config payload", () => {
  it("maps enabled built-in apps and resolves their display names", () => {
    const config = {
      ...defaultMeetingAutoRecordConfig(),
      appIds: ["tencent-meeting", "zoom"],
    };
    const payload = toDetectorConfigPayload(config, (key) => `name:${key}`);
    expect(payload.enabled).toBe(false);
    expect(payload.startDebounceSecs).toBe(15);
    expect(payload.endGraceSecs).toBe(90);
    expect(payload.apps.map((app) => app.id)).toEqual(["tencent-meeting", "zoom"]);
    expect(payload.apps[0]?.name).toBe("name:auto_record.app_tencent_meeting");
    expect(payload.apps[0]?.bundleIds).toContain("com.tencent.wemeetapp");
    expect(payload.apps[0]?.processNames).toContain("wemeetapp");
  });

  it("appends custom apps and reflects the toggle", () => {
    const config = {
      ...defaultMeetingAutoRecordConfig(),
      enabled: true,
      appIds: [],
      customApps: [{ id: "custom:1", name: "Internal", bundleIds: [], processNames: ["meet"] }],
    };
    const payload = toDetectorConfigPayload(config, (key) => key);
    expect(payload.enabled).toBe(true);
    expect(payload.apps).toHaveLength(1);
    expect(payload.apps[0]?.processNames).toEqual(["meet"]);
    expect(KNOWN_MEETING_APPS.length).toBeGreaterThanOrEqual(5);
  });
});
