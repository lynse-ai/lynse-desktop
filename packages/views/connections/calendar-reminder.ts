import { fetchCalendarEvents, type CalendarEvent } from "@lynse/core/integrations";

/**
 * Calendar-driven pre-meeting reminders (PRD FR-1).
 *
 * Pure logic + a localStorage config, deliberately mirroring
 * `live-translation/meeting-auto-record.ts`: the config is plain JSON under a
 * non-secret key and the decision function is side-effect free so the policy
 * can be unit-tested without a clock hack.
 *
 * P0 delivers an in-app banner only. A real OS notification needs
 * `tauri-plugin-notification`, which the app does not depend on today
 * (`apps/tauri/src-tauri/Cargo.toml:46-51` ships dialog/log/opener/process/
 * single-instance/updater), so a reminder cannot reach the user while Lynse is
 * in the background — the UI says so rather than implying otherwise.
 */

export const CALENDAR_REMINDER_CONFIG_KEY = "lynse_calendar_reminder_config";

/** Pocket reminds one minute before a linked meeting; keep that as the default. */
export const DEFAULT_REMINDER_LEAD_MINUTES = 1;

/** How often the banner re-reads the calendar window. */
export const REMINDER_POLL_MS = 30_000;

export interface CalendarReminderConfig {
  enabled: boolean;
  leadMinutes: number;
}

export const DEFAULT_CALENDAR_REMINDER_CONFIG: CalendarReminderConfig = {
  enabled: true,
  leadMinutes: DEFAULT_REMINDER_LEAD_MINUTES,
};

export function loadCalendarReminderConfig(): CalendarReminderConfig {
  try {
    const raw = localStorage.getItem(CALENDAR_REMINDER_CONFIG_KEY);
    if (!raw) return DEFAULT_CALENDAR_REMINDER_CONFIG;
    const parsed = JSON.parse(raw) as Partial<CalendarReminderConfig>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
      leadMinutes:
        typeof parsed.leadMinutes === "number" && parsed.leadMinutes >= 0 && parsed.leadMinutes <= 120
          ? parsed.leadMinutes
          : DEFAULT_REMINDER_LEAD_MINUTES,
    };
  } catch {
    return DEFAULT_CALENDAR_REMINDER_CONFIG;
  }
}

export function saveCalendarReminderConfig(config: CalendarReminderConfig): void {
  try {
    localStorage.setItem(CALENDAR_REMINDER_CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* storage unavailable — the banner just keeps its in-memory config */
  }
}

/**
 * Events that should raise a reminder now: within the lead window, not already
 * started, carrying a join link (a linkless event is not a meeting Lynse can
 * join), and from an account whose Notify switch is on.
 *
 * `notifyAccountIds` is optional: when the caller has no account list (web
 * build, or status still loading) every linked event qualifies, which matches
 * the pre-existing behaviour of the auto-record agent.
 */
export function findReminderDueEvents(
  events: CalendarEvent[],
  nowMs: number,
  config: CalendarReminderConfig,
  notifyAccountIds?: Set<string>,
): CalendarEvent[] {
  if (!config.enabled) return [];
  const leadMs = config.leadMinutes * 60_000;
  return events
    .filter((event) => {
      if (!event.meeting_url) return false;
      if (notifyAccountIds && !notifyAccountIds.has(event.account_id)) return false;
      const startMs = Date.parse(event.start_time);
      if (Number.isNaN(startMs)) return false;
      return startMs > nowMs && startMs - nowMs <= leadMs;
    })
    .sort((a, b) => Date.parse(a.start_time) - Date.parse(b.start_time));
}

/**
 * Does a detector event coincide with a calendar meeting? Used to attribute an
 * auto-started recording to its event — the association PRD FR-1 wants on the
 * note (P1, once `file.calendar_event_id` exists). Tolerance covers the gap
 * between "the calendar says it starts" and "the app actually launches".
 */
export function matchCalendarEvent(
  events: CalendarEvent[],
  detectedAtMs: number,
  toleranceMs = 5 * 60_000,
): CalendarEvent | null {
  let best: CalendarEvent | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const event of events) {
    const startMs = Date.parse(event.start_time);
    const endMs = Date.parse(event.end_time);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
    // Inside the event, or starting within the tolerance window.
    const inside = detectedAtMs >= startMs - toleranceMs && detectedAtMs <= endMs;
    if (!inside) continue;
    const distance = Math.abs(detectedAtMs - startMs);
    if (distance < bestDistance) {
      best = event;
      bestDistance = distance;
    }
  }
  return best;
}

/** Minutes until start, rounded up, for the banner's countdown label. */
export function minutesUntilStart(event: CalendarEvent, nowMs: number): number {
  const startMs = Date.parse(event.start_time);
  return Math.max(0, Math.ceil((startMs - nowMs) / 60_000));
}

/**
 * Which calendar meeting does a detection at `detectedAtMs` belong to?
 *
 * Attribution only for now: PRD FR-1 wants the note to carry the event, but the
 * `file.calendar_event_id` column is P1 (it does not exist today), so callers
 * log the match instead of inventing a place to store it. The fetcher is
 * injectable so the ±15-minute window logic is testable without a network.
 */
export async function findCalendarEventForDetection(
  detectedAtMs: number,
  toleranceMs = 5 * 60_000,
  fetcher: typeof fetchCalendarEvents = fetchCalendarEvents,
): Promise<CalendarEvent | null> {
  const padMs = Math.max(toleranceMs, 15 * 60_000);
  try {
    const response = await fetcher({
      from: new Date(detectedAtMs - padMs).toISOString(),
      to: new Date(detectedAtMs + padMs).toISOString(),
    });
    return matchCalendarEvent(response.events, detectedAtMs, toleranceMs);
  } catch {
    // A calendar read must never break the recording path.
    return null;
  }
}
