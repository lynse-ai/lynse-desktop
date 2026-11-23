import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, setApiInstance, setApiTransportMode } from "./client";
import { addHotword, deleteHotword, listHotwords, updateHotword } from "./hotwords";

describe("hotwords api client", () => {
  let client: ApiClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new ApiClient("https://business.invalid");
    client.setToken("test-session-token");
    setApiInstance(client);
    setApiTransportMode("direct");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setApiTransportMode("proxy");
  });

  it("lists hotwords with session token in Authorization header", async () => {
    const mockList = [
      {
        id: "1946012345678901234",
        content: "张伟明",
        weight: 3,
        createTime: "2026-09-11 19:30:00",
        updateTime: "2026-09-11 19:30:00",
      },
    ];

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 200, msg: "操作成功", data: mockList })),
    );

    const controller = new AbortController();
    const result = await listHotwords(controller.signal);

    expect(result).toEqual(mockList);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://business.invalid/api/business/ai/hotword/list");
    expect(init?.method).toBe("GET");
    expect(init?.headers?.Authorization).toBe("test-session-token");
    expect(init?.headers?.Authorization?.startsWith("Bearer ")).toBe(false);
  });

  it("returns an empty array when data is empty or non-array", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 200, msg: "操作成功", data: [] })),
    );

    const result = await listHotwords();
    expect(result).toEqual([]);
  });

  it("adds a new hotword with content and weight", async () => {
    const createdVO = {
      id: "1946012345678901235",
      content: "智能语音项目",
      weight: 50,
      createTime: "2026-09-11 19:35:00",
      updateTime: "2026-09-11 19:35:00",
    };

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 200, msg: "操作成功", data: createdVO })),
    );

    const result = await addHotword({ content: "智能语音项目", weight: 50 });

    expect(result).toEqual(createdVO);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://business.invalid/api/business/ai/hotword/add");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ content: "智能语音项目", weight: 50 });
    expect(init?.headers?.Authorization).toBe("test-session-token");
  });

  it("updates an existing hotword", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 200, msg: "操作成功", data: true })),
    );

    const result = await updateHotword({
      id: "1946012345678901234",
      content: "张伟明修改",
      weight: 4,
    });

    expect(result).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://business.invalid/api/business/ai/hotword/update");
    expect(init?.method).toBe("PUT");
    expect(JSON.parse(init?.body as string)).toEqual({
      id: "1946012345678901234",
      content: "张伟明修改",
      weight: 4,
    });
  });

  it("deletes a hotword with query param id", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ code: 200, msg: "操作成功", data: true })),
    );

    const result = await deleteHotword("1946012345678901234");

    expect(result).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://business.invalid/api/business/ai/hotword/delete?id=1946012345678901234");
    expect(init?.method).toBe("DELETE");
  });

  it("throws ApiError when server returns non-200 envelope code", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: 400,
            msg: "该热词已存在，请勿重复添加",
            data: null,
          }),
        ),
      ),
    );

    await expect(addHotword({ content: "重复词" })).rejects.toThrowError(ApiError);
    await expect(addHotword({ content: "重复词" })).rejects.toThrow("该热词已存在，请勿重复添加");
  });
});
