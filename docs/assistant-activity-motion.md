# Assistant activity motion

Visual references, inspected at ZCode commit `a60ba6a7e5a06742270ca605f5d2cc2766afa7e1`:

- [ChatLoadingPixels and ChatLoading](https://github.com/zai-org/ZCode/blob/a60ba6a7e5a06742270ca605f5d2cc2766afa7e1/packages/ui/src/components/ai-elements/chat-loading.tsx): a small clockwise pixel orbit, quiet status copy, and a separate elapsed timer.
- [ReasoningTrigger](https://github.com/zai-org/ZCode/blob/a60ba6a7e5a06742270ca605f5d2cc2766afa7e1/packages/ui/src/components/ai-elements/reasoning.tsx): a stationary semantic icon with an animated text highlight.

The local implementation uses SVG pixels, opacity-only orbit phases, existing theme colors, and a masked text overlay with opposing CSS transforms. It does not copy ZCode source or add a runtime dependency. The 960 ms orbit indicates ongoing work; the 2.4 s text sweep follows the existing status-shimmer cadence.

Chat and the meeting side panel share the same waiting component. Server progress and elapsed time remain separate from the highlight. When reasoning is active, its title supplies the activity indication without an extra waiting row. Terminal turns and turns awaiting confirmation do not show the waiting animation. Reduced motion renders static pixels and normal readable text.
