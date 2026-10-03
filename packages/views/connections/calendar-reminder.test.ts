/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CalendarEvent } from "@lynse/core/integrations";
import {
  CALENDAR_REMINDER_CONFIG_KEY,
  DEFAULT_CALENDAR_REMINDER_CONFIG,
  DEFAULT_REMINDER_LEAD_MINUTES,
  findReminderDueEvents,
  loadCalendarReminderConfig,
  matchCalendarEvent,
  minutesUntilStart,
  saveCalendarReminderConfig,
} from "./calendar-reminder";

const T0 = Date.parse("2026-10-05T09:00:00.000Z");

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt-1",
    title: "Standup",
    start_time: new Date(T0 + 60_000).toISOString(),
    end_time: new Date(T0 + 30 * 60_000).toISOString(),
    meeting_url: "https://meet.example/1",
    account_id: "acct-1",
    ...overrides,
  };
}

const CONFIG = { enabled: true, leadMinutes: 5 };

describe("findReminderDueEvents", () => {
  it("fires inside the lead window", () => {
    expect(findReminderDueEvents([event()], T0, CONFIG)).toHaveLength(1);
  });

  it("stays silent outside the window", () => {
    const later = event({ start_time: new Date(T0 + 20 * 60_000).toISOString() });
    expect(findReminderDueEvents([later], T0, CONFIG)).toHaveLength(0);
  });

  it("never reminds for a meeting that already started", () => {
    const past = event({ start_time: new Date(T0 - 10 * 60_000).toISOString() });
    expect(findReminderDueEvents([past], T0, CONFIG)).toHaveLength(0);
  });

  it("skips linkless events — there is nothing for Lynse to join", () => {
    expect(findReminderDueEvents([event({ meeting_url: null })], T0, CONFIG)).toHaveLength(0);
  });

  it("respects the per-account Notify switch", () => {
    const events = [event({ id: "a", account_id: "acct-1" }), event({ id: "b", account_id: "acct-2" })];
    const only1 = findReminderDueEvents(events, T0, CONFIG, new Set(["acct-1"]));
    expect(only1.map((e) => e.id)).toEqual(["a"]);
  });

  it("does nothing when the feature is switched off", () => {
    expect(findReminderDueEvents([event()], T0, { enabled: false, leadMinutes: 5 })).toHaveLength(0);
  });

  it("orders soonest first", () => {
    const a = event({ id: "later", start_time: new Date(T0 + 4 * 60_000).toISOString() });
    const b = event({ id: "sooner", start_time: new Date(T0 + 60_000).toISOString() });
    expect(findReminderDueEvents([a, b], T0, CONFIG).map((e) => e.id)).toEqual(["sooner", "later"]);
  });

  it("ignores an unparseable start time instead of throwing", () => {
    expect(findReminderDueEvents([event({ start_time: "not-a-date" })], T0, CONFIG)).toHaveLength(0);
  });
});

describe("matchCalendarEvent", () => {
  it("matches a detector event that lands inside the meeting", () => {
    const e = event();
    expect(matchCalendarEvent([e], T0 + 10 * 60_000)?.id).toBe("evt-1");
  });

  it("matches slightly early, within tolerance", () => {
    expect(matchCalendarEvent([event()], T0)?.id).toBe("evt-1");
  });

  it("returns null when nothing overlaps", () => {
    expect(matchCalendarEvent([event()], T0 + 5 * 60 * 60_000)).toBeNull();
  });

  it("prefers the nearest start when two meetings overlap", () => {
    const far = event({ id: "far", start_time: new Date(T0 - 20 * 60_000).toISOString() });
    const near = event({ id: "near", start_time: new Date(T0 + 60_000).toISOString() });
    expect(matchCalendarEvent([far, near], T0 + 2 * 60_000)?.id).toBe("near");
  });
});

describe("minutesUntilStart", () => {
  it("rounds up so a starting-now meeting never reads 0 minutes ago", () => {
    expect(minutesUntilStart(event(), T0)).toBe(1);
    expect(minutesUntilStart(event({ start_time: new Date(T0 - 60_000).toISOString() }), T0)).toBe(0);
  });
});

describe("config persistence", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("falls back to defaults with nothing stored", () => {
    expect(loadCalendarReminderConfig()).toEqual(DEFAULT_CALENDAR_REMINDER_CONFIG);
  });

  it("round-trips a saved value", () => {
    saveCalendarReminderConfig({ enabled: false, leadMinutes: 15 });
    expect(loadCalendarReminderConfig()).toEqual({ enabled: false, leadMinutes: 15 });
  });

  it("rejects an out-of-range lead instead of honouring it", () => {
    localStorage.setItem(CALENDAR_REMINDER_CONFIG_KEY, JSON.stringify({ enabled: true, leadMinutes: 9999 }));
    expect(loadCalendarReminderConfig().leadMinutes).toBe(DEFAULT_REMINDER_LEAD_MINUTES);
  });

  it("survives corrupt storage", () => {
    localStorage.setItem(CALENDAR_REMINDER_CONFIG_KEY, "{not json");
    expect(loadCalendarReminderConfig()).toEqual(DEFAULT_CALENDAR_REMINDER_CONFIG);
  });
});
