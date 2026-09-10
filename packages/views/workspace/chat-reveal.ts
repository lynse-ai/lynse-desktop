import type { ChatMessage } from "./types";

/**
 * The poll transport replays the finished answer as a client-side typewriter;
 * these helpers only time the staggered entrance of attachments / support
 * links, which land with `done` after the text has finished typing.
 */
/** Attachments & cards enter this long after the text started fading in. */
export const CHAT_REVEAL_STAGGER_MS = 350;

/** How long after `revealedAt` the reveal animation may still play. */
const REVEAL_WINDOW_MS = 1500;

/**
 * True while the answer's one-shot reveal may still animate (checked at
 * render). History messages and conversation switches carry an old
 * `revealedAt`, so they render instantly without replaying the animation.
 */
export function isFreshlyRevealed(message: ChatMessage, now: number = Date.now()): boolean {
  return message.revealedAt != null && now - message.revealedAt < REVEAL_WINDOW_MS;
}
