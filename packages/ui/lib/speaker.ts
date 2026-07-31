// Stable, theme-aware colors for distinguishing live-translation speakers.
// Backed by the `--speaker-1..8` CSS variables declared in
// `packages/ui/styles/tokens.css` (light + dark), so the dots follow the
// active theme automatically.

export const SPEAKER_COLORS = [
  "var(--speaker-1)",
  "var(--speaker-2)",
  "var(--speaker-3)",
  "var(--speaker-4)",
  "var(--speaker-5)",
  "var(--speaker-6)",
  "var(--speaker-7)",
  "var(--speaker-8)",
];

/**
 * Deterministically map a speaker label (e.g. "发言人1", "我", "spk-2") to one
 * of the eight speaker colors. The same name always yields the same color,
 * which keeps a person's dot stable across utterances and re-renders.
 */
export function getSpeakerColor(name: string): string {
  if (!name) return SPEAKER_COLORS[0]!;
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return SPEAKER_COLORS[Math.abs(hash) % SPEAKER_COLORS.length]!;
}
