/**
 * Skill quick prompts carry a machine-facing `[Label](skill://slug)` marker
 * that the backend agent picks up and executes. The marker must never be
 * user-visible: the composer drops only the prompt body, the marker is
 * re-attached when the message is sent, and rendered surfaces strip it.
 */

const SKILL_MARKER_PATTERN = /^\[([^\]]*)\]\((skill:\/\/[^\s)]+)\)[ \t]*/;

export interface SkillMarker {
  /** Full `[Label](skill://slug)` text, re-attached ahead of the body on send. */
  marker: string;
  /** Label inside the brackets, e.g. "Meeting minutes". */
  label: string;
  /** Prompt body without the marker — the only part shown in the UI. */
  body: string;
}

/** Split the leading `skill://` marker off a skill prompt; null when none. */
export function extractSkillMarker(text: string): SkillMarker | null {
  const match = SKILL_MARKER_PATTERN.exec(text);
  if (!match) return null;
  return {
    marker: match[0].trimEnd(),
    label: match[1] ?? "",
    body: text.slice(match[0].length),
  };
}

/** UI-safe text: the body when a marker leads the string, otherwise unchanged. */
export function stripSkillMarker(text: string): string {
  return extractSkillMarker(text)?.body ?? text;
}
