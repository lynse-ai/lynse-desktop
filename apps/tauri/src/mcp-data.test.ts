import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lynse/core/api", () => ({ api: vi.fn() }));
vi.mock("@lynse/core/auth", () => ({ getAuthStore: vi.fn() }));
vi.mock("@lynse/views/workspace", () => ({ getDesktopLocalTranscriptionApi: vi.fn(), getDesktopVaultApi: vi.fn() }));
vi.mock("@lynse/views/inspiration", () => ({ getDesktopInspirationApi: vi.fn() }));
import { readDesktopMcpTool, type McpDataDependencies } from "./mcp-data";

let deps: McpDataDependencies;
beforeEach(() => {
  deps = {
    meetings: vi.fn().mockResolvedValue([{ id:"local-1", title:"Design", transcriptText:"Public transcript", providerConfig:{apiKey:"secret"}, sourcePath:"/private/audio.wav" }]),
    notes: vi.fn().mockResolvedValue([
      { id:"shared", text:"Shared note" },
      { id:"opt-out", text:"Private note", aiContextEnabled:false },
      { id:"restricted", text:"Restricted note", sensitivity:"restricted" },
    ]),
    todos: vi.fn().mockResolvedValue([{id:"open", title:"Review", completed:false}, {id:"done", title:"Ship", completed:true}]),
    readMeetingNote: vi.fn().mockResolvedValue("# Notes"),
    cloud: { getToken:vi.fn().mockReturnValue("session"), getBaseUrl:vi.fn().mockReturnValue("https://cloud.test"), get:vi.fn().mockResolvedValue({items:[]}), post:vi.fn().mockResolvedValue({items:[]}) },
    authenticated: vi.fn().mockReturnValue(true),
  };
});

describe("Desktop MCP data access", () => {
  it("returns local transcripts without provider credentials or file paths", async () => {
    const result = await readDesktopMcpTool("get_local_meeting", {id:"local-1", content:"transcript"}, deps);
    expect(result).toEqual({id:"local-1", title:"Design", transcriptText:"Public transcript"});
    expect(deps.cloud.get).not.toHaveBeenCalled();
  });

  it("respects local note AI exclusions in both listing and direct lookup", async () => {
    expect(await readDesktopMcpTool("list_local_notes", {}, deps)).toEqual({total:1, items:[{id:"shared", text:"Shared note"}]});
    for (const id of ["opt-out", "restricted"]) {
      await expect(readDesktopMcpTool("get_local_note", {id}, deps)).rejects.toThrow("not shared with AI");
    }
  });

  it("only reads vault notes belonging to an existing local meeting", async () => {
    await expect(readDesktopMcpTool("get_local_meeting", {id:"../../secret", content:"notes"}, deps)).rejects.toThrow("Record not found");
    expect(deps.readMeetingNote).not.toHaveBeenCalled();
    expect(await readDesktopMcpTool("get_local_meeting", {id:"local-1", content:"notes"}, deps)).toEqual({id:"local-1", markdown:"# Notes"});
    expect(deps.readMeetingNote).toHaveBeenCalledWith("local-1");
  });

  it("keeps local data readable offline while cloud requests require login", async () => {
    deps.authenticated = () => false;
    expect(await readDesktopMcpTool("list_local_todos", {status:"open"}, deps)).toEqual({total:1, items:[{id:"open", title:"Review", completed:false}]});
    await expect(readDesktopMcpTool("list_cloud_meetings", {}, deps)).rejects.toThrow("Sign in");
    expect(deps.cloud.get).not.toHaveBeenCalled();
  });

  it("uses fixed read endpoints and validated pagination", async () => {
    await readDesktopMcpTool("list_cloud_meetings", {keyword:"Design", page:2, page_size:10}, deps);
    expect(deps.cloud.get).toHaveBeenCalledWith("/api/business/file/page", {originalFilename:"Design", pageNum:2, pageSize:10});
    await readDesktopMcpTool("get_cloud_meeting", {id:"file-1", content:"transcript"}, deps);
    expect(deps.cloud.get).toHaveBeenCalledWith("/api/business/file/trans/get", {fileId:"file-1"});
    await readDesktopMcpTool("list_cloud_todos", {status:"done"}, deps);
    expect(deps.cloud.post).toHaveBeenCalledWith("/api/business/file/todo/list", {pageNum:1, pageSize:20, isCompleted:1});
    await expect(readDesktopMcpTool("list_cloud_meetings", {page_size:101}, deps)).rejects.toThrow("Invalid page_size");
    await expect(readDesktopMcpTool("delete_cloud_meeting", {id:"file-1"}, deps)).rejects.toThrow("Unknown tool");
  });

  it.each(["logout", "account", "server"])("discards results after %s changes during a cloud request", async (change) => {
    deps.cloud.get = async () => {
      if (change === "logout") deps.authenticated = () => false;
      if (change === "account") deps.cloud.getToken = () => "different-session";
      if (change === "server") deps.cloud.getBaseUrl = () => "https://other.test";
      return {items:[{title:"Should not escape"}]};
    };
    await expect(readDesktopMcpTool("list_cloud_meetings", {}, deps)).rejects.toThrow("Account or server changed");
  });

  it("omits private account fields from cloud profile results", async () => {
    deps.cloud.get = vi.fn().mockResolvedValue({id:1, nickname:"Lynse", apiKey:"secret", token:"secret", phone:"private"});
    expect(await readDesktopMcpTool("get_cloud_user", {}, deps)).toEqual({id:1, nickname:"Lynse"});
  });
});
