/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { ChatImagePicker, readChatImage, readChatDocument, useChatImages } from "./chat-images";
import { useChatStore } from "../workspace/hooks/use-chat-store";
import { saveChatHistory } from "../workspace/chat-history";

const DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=";
const image = () => new File([Uint8Array.from(atob(DATA.split(",")[1]!), c => c.charCodeAt(0))], "icon.png", {type:"image/png"});
afterEach(() => { cleanup(); window.localStorage.clear(); });

describe("assistant image drafts", () => {
  it("validates actual bytes and rejects disguised or oversized files", async () => {
    expect((await readChatImage(image())).dataUrl).toBe(DATA);
    await expect(readChatImage(new File(["fake"], "photo.png", {type:"image/png"}))).rejects.toThrow();
    const big = image(); Object.defineProperty(big, "size", {value: 6 * 1024 * 1024});
    await expect(readChatImage(big)).rejects.toThrow();
  });
  it("keeps drafts out of other conversations and accounts", async () => {
    useChatStore.setState({userId:"image-user-a"});
    const { result, rerender } = renderHook(({conversation}) => useChatImages(conversation), {initialProps:{conversation:"a"}});
    await act(async () => { await result.current.add([image()]); });
    expect(result.current.drafts).toHaveLength(1);
    rerender({conversation:"b"});
    expect(result.current.drafts).toHaveLength(0);
    await act(async () => { await result.current.add([image()]); });
    act(() => { useChatStore.setState({userId:"image-user-b"}); });
    expect(result.current.drafts).toHaveLength(0);
  });
  it("drops asynchronous reads after a conversation switch", async () => {
    const { result, rerender } = renderHook(({conversation}) => useChatImages(conversation), {initialProps:{conversation:"a"}});
    let reading: Promise<void>;
    act(() => { reading = result.current.add([image()]); });
    rerender({conversation:"b"});
    await act(async () => { await reading; });
    expect(result.current.drafts).toHaveLength(0);
  });
  it("persists filenames without raw image data", () => {
    saveChatHistory("image-user", {activeConversationId:"c", conversations:[{
      id:"c", title:"Image", provider:"cloud", createdAt:1, updatedAt:1,
      messages:[{id:"m", role:"user", content:"Explain", timestamp:1,
        attachments:[{id:"i",name:"icon.png",type:"image",inputAttachment:true,url:DATA,thumbnailUrl:DATA}]}],
    }]});
    const stored = window.localStorage.getItem("lynse_ai_chat_history_v1:image-user")!;
    expect(stored).toContain("icon.png");
    expect(stored).not.toContain("base64");
  });
});

describe("attachment menu and camera", () => {
  it("offers camera, photo library and common document formats from the plus button", () => {
    const {container}=render(<ChatImagePicker onFiles={()=>{}} />);
    fireEvent.click(screen.getByRole("button",{name:/^Add$|^添加$/}));
    expect(screen.getByRole("button",{name:/Take photo|拍照/})).toBeTruthy();
    expect(screen.getByRole("button",{name:/Photo library|相册/})).toBeTruthy();
    expect(screen.getByRole("button",{name:/Files|文件/})).toBeTruthy();
    expect(container.querySelectorAll('input[type="file"]')[1]?.getAttribute("accept")).toContain(".ppt,.pptx,.xls,.xlsx");
  });
  it("reads common document drafts and rejects unsupported formats", async () => {
    expect((await readChatDocument(new File(["# Notes"],"notes.md",{type:"text/markdown"}))).kind).toBe("document");
    await expect(readChatDocument(new File(["code"],"run.exe"))).rejects.toThrow();
  });
  it("stops the camera on close and never requests microphone access", async () => {
    const stop=vi.fn();
    const getUserMedia=vi.fn().mockResolvedValue({getTracks:()=>[{stop}]});
    const previous=Object.getOwnPropertyDescriptor(navigator,"mediaDevices");
    Object.defineProperty(navigator,"mediaDevices",{value:{getUserMedia},configurable:true});
    try {
      render(<ChatImagePicker onFiles={()=>{}} />);
      fireEvent.click(screen.getByRole("button",{name:/^Add$|^添加$/}));
      fireEvent.click(screen.getByRole("button",{name:/Take photo|拍照/}));
      await waitFor(()=>expect(getUserMedia).toHaveBeenCalledWith({video:{facingMode:"environment"},audio:false}));
      fireEvent.click(screen.getByRole("button",{name:/Cancel|取消/}));
      await waitFor(()=>expect(stop).toHaveBeenCalled());
    } finally { if(previous)Object.defineProperty(navigator,"mediaDevices",previous);else Reflect.deleteProperty(navigator,"mediaDevices"); }
  });
  it("explains denied or missing camera permission without silently failing", async () => {
    const previous=Object.getOwnPropertyDescriptor(navigator,"mediaDevices");
    Object.defineProperty(navigator,"mediaDevices",{value:{getUserMedia:vi.fn().mockRejectedValue(new Error("NotAllowedError"))},configurable:true});
    try {
      render(<ChatImagePicker onFiles={()=>{}} />);
      fireEvent.click(screen.getByRole("button",{name:/^Add$|^添加$/}));
      fireEvent.click(screen.getByRole("button",{name:/Take photo|拍照/}));
      expect(await screen.findByRole("alert")).toBeTruthy();
    } finally { if(previous)Object.defineProperty(navigator,"mediaDevices",previous);else Reflect.deleteProperty(navigator,"mediaDevices"); }
  });
});
