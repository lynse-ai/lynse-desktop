/* @vitest-environment jsdom */

/**
 * Streaming smoothness benchmark for the chat page (AI suggestions).
 *
 * Replays a realistic assistant answer through the real chat engine (store +
 * poll transport + StreamingMarkdown) at the typewriter cadence (~24 ms per
 * delta, see chatPollTiming.typewriterTickMs) while counting the work each
 * delta costs:
 *
 *   - storeWrites      — chat-store notifications per delta (each one is a
 *                        potential React render pass)
 *   - completedRenders — re-renders of ALREADY-FINISHED messages' markdown.
 *                        Pure waste: their content never changes while a new
 *                        reply streams.
 *   - streamingRenders — re-renders of the message currently typing (needed).
 *
 * The assertions encode the accepted budgets; if a change regresses streaming
 * efficiency beyond them, this test fails.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Profiler } from "react";

// ── render/work counters (hoisted so the mocks below can touch them) ──
const counters = vi.hoisted(() => ({
  storeWrites: 0,
  completedRenders: 0,
  streamingRenders: 0,
  pageCommits: 0,
  pageActualMs: 0,
}));

const resetCounters = () => {
  counters.storeWrites = 0;
  counters.completedRenders = 0;
  counters.streamingRenders = 0;
  counters.pageCommits = 0;
  counters.pageActualMs = 0;
};

// The poll transport is replaced with a scripted replay so the benchmark is
// deterministic: DELTA_COUNT deltas at the real ~24 ms typewriter cadence.
const TIMING = vi.hoisted(() => ({ deltaCount: 60, tickMs: 24 }));

vi.mock("../workspace/chat-transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workspace/chat-transport")>();
  class FakePollTransport {
    private cancelled = false;
    readonly provider = "cloud" as const;
    cancel() {
      this.cancelled = true;
    }
    async send(opts: {
      onEvent: (evt: { type: string; delta?: string; text?: string }) => void;
    }): Promise<void> {
      const full = FULL_TEXT.value;
      const slice = Math.ceil(full.length / TIMING.deltaCount);
      for (let at = 0; at < full.length && !this.cancelled; at += slice) {
        await new Promise((resolve) => setTimeout(resolve, TIMING.tickMs));
        opts.onEvent({ type: "content", delta: full.slice(at, at + slice) });
      }
      if (!this.cancelled) opts.onEvent({ type: "done", text: full });
    }
  }
  return {
    ...actual,
    PollChatTransport: FakePollTransport,
    extractConfirmFromText: () => null,
  };
});

// Keep the markdown pipeline REAL (it is the workload being measured) but wrap
// StreamingMarkdown to attribute renders to the finished vs typing message.
vi.mock("@lynse/ui/markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lynse/ui/markdown")>();
  const React = await import("react");
  const CountingStreamingMarkdown = (props: { content: string; isStreaming: boolean }) => {
    if (props.isStreaming) counters.streamingRenders += 1;
    else counters.completedRenders += 1;
    const Actual = actual.StreamingMarkdown as React.ComponentType<typeof props>;
    return React.createElement(Actual, props);
  };
  return { ...actual, StreamingMarkdown: CountingStreamingMarkdown };
});

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }),
}));
vi.mock("../workspace/hooks/use-files", () => ({
  useNotes: () => ({ data: [] }),
}));
vi.mock("../workspace/hooks/use-folders", () => ({
  useFolders: () => ({ data: [] }),
}));

import { ChatPage } from "./page";
import { useChatStore } from "../workspace/hooks/use-chat-store";
import { redactMeetingIds } from "../workspace/meeting-id-redact";

// A representative answer: headings, lists, a table and a code block — the
// shapes that make full-document markdown re-parses expensive. Deliberately
// free of redactable ID patterns so content equality checks stay simple.
const FULL_TEXT = vi.hoisted(() => ({
  value: [
    "好的，下面是本次评审的要点整理。",
    "",
    "## 关键结论",
    "",
    "- 录音链路已完成本地持久化",
    "- 实时转写的断线重连表现稳定",
    "- 建议下一阶段聚焦剪辑体验",
    "",
    "| 阶段 | 负责人 | 状态 |",
    "| --- | --- | --- |",
    "| 转写 | 张三 | 完成 |",
    "| 翻译 | 李四 | 进行中 |",
    "| 剪辑 | 王五 | 待开始 |",
    "",
    "```ts",
    "export function smooth(level: number): number {",
    "  return Math.min(1, Math.max(0, level));",
    "}",
    "```",
    "",
    "总体来看进展顺利，细节可以再看一遍纪要。",
  ].join("\n"),
}));

function seedCompletedMessages() {
  const make = (id: string, content: string) => ({
    id,
    role: "assistant" as const,
    content,
    timestamp: Date.now(),
  });
  return [
    make("done-1", "第一轮回答：项目当前处于收尾阶段，重点是稳定性和性能。"),
    make("done-2", FULL_TEXT.value),
    make("done-3", "第三轮回答：剪辑功能已经在内测环境验证通过，下周发布。"),
    make("done-4", "第四轮回答：会议纪要的导出格式支持 Markdown 与 PDF。"),
  ];
}

describe("chat streaming performance", () => {
  beforeEach(() => {
    resetCounters();
    localStorage.clear();
    useChatStore.setState({
      messages: [],
      conversations: [],
      activeConversationId: null,
      pendingConfirm: null,
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
    useChatStore.getState().clearMessages();
    useChatStore.setState({ conversations: [] });
  });

  it("keeps streaming work within budget (finished messages never re-render)", async () => {
    const completed = seedCompletedMessages();
    useChatStore.setState({
      messages: completed,
      conversations: [
        {
          id: "conv",
          title: "perf",
          messages: completed,
          provider: "cloud" as const,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      activeConversationId: "conv",
    });

    useChatStore.subscribe(() => {
      counters.storeWrites += 1;
    });

    const onRender = (_id: string, phase: string, actualDuration: number) => {
      if (phase === "update") {
        counters.pageCommits += 1;
        counters.pageActualMs += actualDuration;
      }
    };

    render(
      <Profiler id="page" onRender={onRender}>
        <ChatPage />
      </Profiler>,
    );

    // Baseline after mount, before the stream starts.
    const writesBefore = counters.storeWrites;
    const completedBefore = counters.completedRenders;
    const streamingBefore = counters.streamingRenders;
    const commitsBefore = counters.pageCommits;
    const msBefore = counters.pageActualMs;

    await act(async () => {
      useChatStore.getState().sendMessage("帮我总结一下");
    });

    // The final content must land intact (nothing lost by batching).
    await waitFor(() => {
      const last = useChatStore.getState().messages.at(-1);
      if (!last || last.content !== redactMeetingIds(FULL_TEXT.value)) throw new Error("pending");
    });

    const writes = counters.storeWrites - writesBefore;
    const completedRenders = counters.completedRenders - completedBefore;
    const streamingRenders = counters.streamingRenders - streamingBefore;
    const commits = counters.pageCommits - commitsBefore;
    const updateMs = counters.pageActualMs - msBefore;

    const deltas = TIMING.deltaCount;
    const baselineWrites = 2 * deltas; // messages + conversations sync per delta
    const baselineCompleted = deltas * completed.length; // every finished message per delta

    console.info(
      `[streaming-perf] deltas=${deltas} storeWrites=${writes} (baseline ~${baselineWrites}) ` +
        `completedRenders=${completedRenders} (baseline ~${baselineCompleted}) ` +
        `streamingRenders=${streamingRenders} pageCommits=${commits} pageUpdateMs=${updateMs.toFixed(1)}`,
    );

    // Budget 1 — finished messages are memoized: zero re-renders while a new
    // reply types (was one full markdown re-parse per message per delta).
    expect(completedRenders).toBe(0);
    // Budget 2 — store notifications coalesced: at least 20% fewer writes than
    // the one-messages-update + one-conversations-update per delta baseline.
    expect(writes).toBeLessThanOrEqual(Math.floor(baselineWrites * 0.8));
    // Budget 3 — the typing message still updates (smoothness preserved).
    expect(streamingRenders).toBeGreaterThan(0);
    expect(streamingRenders).toBeLessThanOrEqual(deltas + 2);
  });
});
