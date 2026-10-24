/* @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryApi, type MemoryFileDocument } from "@lynse/core/api/memory";
import { TopicMemoryLibrary } from "./topic-memory-library";
import { memoryManagementEnglish } from "./memory-management-locales";
import { useMemoryDrafts } from "./memory-drafts";

vi.mock("@lynse/core/api/memory", () => ({ memoryOperationId: () => "frozen-operation", memoryApi: { files: vi.fn(), readFile: vi.fn(), createFile: vi.fn(), saveFile: vi.fn(), organizeFile: vi.fn(), removeEmptyFile: vi.fn(), previewConfirmation: vi.fn(), confirm: vi.fn(), action: vi.fn(), previewForget: vi.fn(), forget: vi.fn(), forgetStatus: vi.fn() } }));
vi.mock("@lynse/core/i18n/react", () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, string | number>) => {
  let value: string = memoryManagementEnglish[key.replace("memory_manager.", "") as keyof typeof memoryManagementEnglish] ?? key;
  for (const [name, replacement] of Object.entries(values ?? {})) value = value.replace(`{{${name}}}`, String(replacement));
  return value;
} }) }));
vi.mock("@lynse/ui/markdown", () => ({ Markdown: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock("./api", () => ({ getWorkbenchApi: () => null }));

let docs: MemoryFileDocument[];
function document(title: string, id: string, pending = false): MemoryFileDocument {
  const member = { id: `mem-${id}`, revision: 3, content: "A smaller enclosure remains a proposal.", status: "candidate", sources: [{ parent_type: "source", parent_id: "meeting:one", parent_revision: 2, excerpt: "灵光记讨论了更小的外壳，尚未决定。" }], eligibility: { usable: false, reasons: ["confirmation_required"] } };
  return { path: `notes/topic-${id}.md`, title, revision: `version-${id}`, editable: true, markdown: `# ${title}\n\nSupported current information.`, members: [], pendingUpdates: pending ? [member] : [], recordIds: pending ? [member.id] : [], pendingCount: pending ? 1 : 0, searchText: pending ? "灵光记讨论了更小的外壳" : title };
}
function mount(account = "alice") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return { ...render(<QueryClientProvider client={client}><TopicMemoryLibrary key={account} account={account} /></QueryClientProvider>), client };
}
beforeEach(() => {
  vi.clearAllMocks(); useMemoryDrafts.getState().clear();
  docs = [document("lynse", "one", true), document("Machine learning course", "two")];
  vi.mocked(memoryApi.files).mockImplementation(async () => ({ files: docs }));
  vi.mocked(memoryApi.readFile).mockImplementation(async path => docs.find(doc => doc.path === path)!);
});
afterEach(cleanup);

describe("Markdown topic memory", () => {
  it("opens files directly with generic subjects and no status navigation", async () => {
    mount();
    await screen.findByRole("button", { name: /Machine learning course.md/ });
    expect(screen.queryByRole("button", { name: "Remembered" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rejected" })).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(await screen.findByText("A smaller enclosure remains a proposal.")).toBeTruthy();
  });

  it("finds an English memory using its original Chinese source text", async () => {
    mount(); await screen.findByRole("button", { name: /Machine learning course.md/ });
    fireEvent.change(screen.getByRole("textbox", { name: "Search memory files…" }), { target: { value: "更小的外壳" } });
    expect(screen.queryByRole("button", { name: /Machine learning course.md/ })).toBeNull();
    expect(screen.getByRole("button", { name: /lynse.md/ })).toBeTruthy();
  });

  it("saves human text in its own language with the draft's frozen revision", async () => {
    vi.mocked(memoryApi.saveFile).mockImplementation(async body => ({ ...docs[0]!, markdown: body.markdown, revision: "saved" }));
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Memory content" }), { target: { value: "# lynse\n\n我的人工补充。" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(memoryApi.saveFile).toHaveBeenCalledWith({ path: docs[0]!.path, revision: "version-one", markdown: "# lynse\n\n我的人工补充。" }, "frozen-operation"));
    expect(useMemoryDrafts.getState().drafts[`alice/${docs[0]!.path}`]).toBeUndefined();
  });

  it("reviews pending updates with an exact server preview before confirmation", async () => {
    vi.mocked(memoryApi.previewConfirmation).mockResolvedValue({ preview_id: "frozen-preview", items: [{ id: "mem-one", revision: 3, fingerprint: "frozen" }] });
    vi.mocked(memoryApi.confirm).mockResolvedValue({ status: "ok" });
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Confirm updates" }));
    const dialog = await screen.findByRole("dialog");
    expect(memoryApi.confirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(memoryApi.confirm).toHaveBeenCalledWith("frozen-preview", "frozen-operation"));
  });

  it("previews deletion and submits the frozen manifest while preserving source recordings", async () => {
    const plan = { plan_id: "plan-one", manifest_hash: "manifest-one", items: [{ id: "mem-one", revision: 3, fingerprint: "frozen" }], preserves_original_sources: true, preserves_wiki_browsing: true };
    vi.mocked(memoryApi.previewForget).mockResolvedValue(plan);
    vi.mocked(memoryApi.forget).mockResolvedValue({ plan_id: "plan-one", state: "complete", stopped_using: true, cloud_cleanup_complete: true, device_sync: "pending", processed: 1, total: 1 });
    mount(); await screen.findByRole("button", { name: "Edit Markdown" });
    fireEvent.click(screen.getByLabelText("File actions")); fireEvent.click(screen.getByRole("button", { name: "Delete memory" }));
    const dialog = await screen.findByRole("dialog"); expect(memoryApi.forget).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete memory" }));
    await waitFor(() => expect(memoryApi.forget).toHaveBeenCalledWith(plan, "frozen-operation"));
  });

  it("creates a Markdown topic without asking for an industry or memory type", async () => {
    vi.mocked(memoryApi.createFile).mockImplementation(async title => { const doc = document(title, "new"); docs.push(doc); return doc; });
    mount(); fireEvent.click(screen.getByRole("button", { name: "New memory" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "File name (English)" }), { target: { value: "Fund review" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(memoryApi.createFile).toHaveBeenCalledWith("Fund review", "frozen-operation"));
  });

  it("does not mount a different account's unsaved draft", async () => {
    useMemoryDrafts.getState().set(`alice/${docs[0]!.path}`, { markdown: "Alice private draft", original: docs[0]!.markdown, revision: "old" });
    mount("bob"); fireEvent.click(await screen.findByRole("button", { name: "Edit Markdown" }));
    expect((screen.getByRole("textbox", { name: "Memory content" }) as HTMLTextAreaElement).value).not.toContain("Alice private draft");
  });
});
