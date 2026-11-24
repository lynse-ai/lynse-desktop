import { listen } from "@tauri-apps/api/event";
import { posthog } from "./posthog";

const AI_GENERATION_EVENT = "posthog-ai-generation";

/**
 * The native layer emits completed provider calls after its work finishes.
 * Capture is deliberately best-effort: analytics must not affect a model call.
 */
export function installAiObservability(): void {
  void listen<Record<string, unknown>>(AI_GENERATION_EVENT, ({ payload }) => {
    posthog.capture("$ai_generation", payload);
  }).catch(() => {});
}
