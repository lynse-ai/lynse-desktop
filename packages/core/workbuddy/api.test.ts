import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../auth/workbuddy", () => ({ callWorkBuddyOpenApi: mocks.call, workBuddySessionGuard: () => () => {} }));
import { createWorkBuddyTask, getWorkBuddyTask, fetchWorkBuddyArtifact, listWorkBuddyArtifacts, setWorkBuddyResourceRelay, workBuddySandboxUrl } from "./api";

beforeEach(() => { vi.resetAllMocks(); setWorkBuddyResourceRelay(null); });

describe("WorkBuddy task and artifact API", () => {
  it("creates once and unwraps task responses without persisting tickets", async () => {
    mocks.call.mockResolvedValue({ code: 0, data: { task_id: "a/b", status: "CREATING", ignored: true } });
    expect(await createWorkBuddyTask("hello")).toMatchObject({ task_id: "a/b", status: "CREATING" });
    expect(mocks.call).toHaveBeenCalledWith("/tasks", { method: "POST", body: { prompt: "hello" } });
    await getWorkBuddyTask("a/b");
    expect(mocks.call).toHaveBeenLastCalledWith("/tasks/a%2Fb");
  });
  it("rejects upstream business errors and invalid task IDs", async () => {
    mocks.call.mockResolvedValueOnce({ code: 42, msg: "denied" }).mockResolvedValueOnce({ status: "READY" });
    await expect(createWorkBuddyTask("hi")).rejects.toThrow("denied");
    await expect(getWorkBuddyTask("a")).rejects.toThrow("Invalid WorkBuddy task");
  });
  it("keeps the task gateway distinct from the sandbox data address", () => {
    expect(workBuddySandboxUrl({ task_id: "a", status: "READY", link: "https://acp.workbuddy.cn/sessions/a" })).toBeNull();
    expect(workBuddySandboxUrl({ task_id: "a", status: "READY", link: "https://a.agentos-run.net/acp" })).toBe("https://a.agentos-run.net");
    expect(workBuddySandboxUrl({ task_id: "a", status: "READY", sandboxDataLink: "https://a.agentos-run.net/data/" })).toBe("https://a.agentos-run.net/data");
  });
  it("renews an expired artifact ticket, preserving the new sandbox URL", async () => {
    const old = { task_id: "a", status: "READY", token: "old", sandboxDataLink: "https://old.agentos-run.net" };
    mocks.call.mockResolvedValue({ ...old, token: "new", sandboxDataLink: "https://new.agentos-run.net" });
    const relay = vi.fn().mockResolvedValueOnce({ status: 401 }).mockResolvedValueOnce({ status: 200, body: '{"code":0,"data":{"artifacts":[{"event":"created"}]}}' });
    setWorkBuddyResourceRelay(relay);
    expect(await listWorkBuddyArtifacts(old)).toEqual([{ event: "created" }]);
    expect(relay.mock.calls[1]![0]).toEqual({ url: "https://new.agentos-run.net/api/session/artifacts?sessionId=a", token: "new", binary: false });
  });
  it("rejects invalid artifact paths before fetching a task", async () => {
    await expect(fetchWorkBuddyArtifact("a", "agent:///../secrets")).rejects.toThrow("Invalid");
    await expect(fetchWorkBuddyArtifact("a", "agent:///%2e%2e/secrets")).rejects.toThrow("Invalid");
    await expect(fetchWorkBuddyArtifact("a", "https://elsewhere.invalid/file")).rejects.toThrow("Unsupported");
    expect(mocks.call).not.toHaveBeenCalled();
  });
});
