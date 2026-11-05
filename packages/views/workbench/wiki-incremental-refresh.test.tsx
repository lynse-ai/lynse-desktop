/* @vitest-environment jsdom */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { useWiki } from "./wiki";

const state = vi.hoisted(() => ({
  status: { scope: "account", updatedAt: "progress-1", wikiRevision: "content-1" },
  wiki: vi.fn(async () => ({ topics: [] })),
}));
vi.mock("./api", () => ({
  useWorkbench: (selector: (value: { status: typeof state.status }) => unknown) => selector({ status: state.status }),
  useWikiEnabled: () => true,
  getWorkbenchApi: () => ({ wiki: state.wiki }),
  refreshWorkbench: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function Harness() { useWiki(); return null; }

it("keeps progress updates from reloading all pages but refreshes changed content", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => <QueryClientProvider client={client}><Harness /></QueryClientProvider>;
  const view = render(tree());
  await waitFor(() => expect(state.wiki).toHaveBeenCalled());
  await act(async () => { await client.getQueryCache().find({ queryKey: ["workbench-wiki", "account"] })?.promise; });
  const initialCalls = state.wiki.mock.calls.length;
  state.status = { ...state.status, updatedAt: "progress-2" };
  await act(async () => { view.rerender(tree()); });
  expect(state.wiki).toHaveBeenCalledTimes(initialCalls);
  state.status = { ...state.status, wikiRevision: "content-2" };
  view.rerender(tree());
  await waitFor(() => expect(state.wiki.mock.calls.length).toBeGreaterThan(initialCalls));
  client.clear();
});
