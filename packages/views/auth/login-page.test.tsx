/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, setApiInstance, setApiTransportMode } from "@lynse/core/api/client";
import { createAuthStore, registerAuthStore } from "@lynse/core/auth";
import { getDesktopAppApi } from "../app-update";
import { LoginPage } from "./login-page";
import { configureBuildChannel } from "../feature-flags";

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("../app-update", () => ({ getDesktopAppApi: vi.fn(), openExternalUrl: vi.fn() }));
vi.mock("../layout/app-title-bar", () => ({ WindowControls: () => null, showWindowControls: () => false }));
vi.mock("./api-auth-panel", () => ({ ApiAuthPanel: () => null }));
vi.mock("../feature-flags", async () => ({
  ...await vi.importActual<typeof import("../feature-flags")>("../feature-flags"),
  hasDevApiAuth: () => false,
  isTestMode: () => false,
  setTestMode: vi.fn(),
}));

const AUTHORIZE_URL = "https://open.weixin.qq.com/connect/qrconnect?appid=wx61e2752a63d15239&redirect_uri=https%3A%2F%2Fapi.lynse.cn%2Fauth%2Fwechat%2Fcallback&state=expected&response_type=code&scope=snsapi_login#wechat_redirect";
let auth: ReturnType<typeof createAuthStore>;
let callback: (url: string) => void;
let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
let openAuthWindow: ReturnType<typeof vi.fn>;
let closeAuthWindow: ReturnType<typeof vi.fn>;
let unlisten: ReturnType<typeof vi.fn>;

beforeEach(() => {
  configureBuildChannel("official");
  const client = new ApiClient("https://gapp.lynse.cn");
  setApiInstance(client);
  setApiTransportMode("direct");
  const saved = new Map<string, string>();
  auth = createAuthStore({ api: client, storage: {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => { saved.set(key, value); },
    removeItem: (key) => { saved.delete(key); },
  } });
  registerAuthStore(auth);
  fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({ code: 200, data: AUTHORIZE_URL }));
  vi.stubGlobal("fetch", fetchMock);
  unlisten = vi.fn();
  openAuthWindow = vi.fn(async () => {});
  closeAuthWindow = vi.fn(async () => {});
  vi.mocked(getDesktopAppApi).mockReturnValue({ wechat: {
    openAuthWindow,
    closeAuthWindow,
    onAuthCallback: vi.fn(async (handler) => { callback = handler; return unlisten; }),
  } } as unknown as ReturnType<typeof getDesktopAppApi>);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setApiTransportMode("proxy");
  configureBuildChannel("official");
});

async function start() {
  render(<LoginPage />);
  fireEvent.click(screen.getByRole("button", { name: "auth.more_login" }));
  fireEvent.click(screen.getByRole("button", { name: "auth.wechat_login" }));
  await waitFor(() => expect(openAuthWindow).toHaveBeenCalledTimes(1));
}

function deferredLogin() {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => { resolve = done; });
  fetchMock.mockImplementation((url: string) => url.includes("/render")
    ? Promise.resolve(Response.json({ code: 200, data: AUTHORIZE_URL }))
    : pending);
  return (data: unknown) => resolve(Response.json({ code: 200, data }));
}

describe("desktop WeChat sign-in", () => {
  it.each(["official", "debug"] as const)("keeps phone and WeChat login available with the %s feature override", async channel => {
    configureBuildChannel(channel);
    render(<LoginPage />);
    expect(screen.getByPlaceholderText("auth.sms_phone_placeholder")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "auth.more_login" }));
    fireEvent.click(screen.getByRole("button", { name: "auth.wechat_login" }));
    await waitFor(() => expect(openAuthWindow).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]![0]).toBe("https://gapp.lynse.cn/api/auth/render?authType=WECHAT_SCAN");
  });
  it("opens the selected server's QR flow and exchanges each code only once", async () => {
    const finish = deferredLogin();
    await start();
    const url = new URL(openAuthWindow.mock.calls[0]![0]);
    expect(openAuthWindow).toHaveBeenCalledWith(AUTHORIZE_URL);
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.lynse.cn/auth/wechat/callback");
    expect(url.pathname).toBe("/connect/qrconnect");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://gapp.lynse.cn/api/auth/render?authType=WECHAT_SCAN");

    act(() => {
      callback("https://api.lynse.cn/auth/wechat/callback?code=once&state=expected");
      callback("https://api.lynse.cn/auth/wechat/callback?code=once&state=expected");
    });
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/login"))).toHaveLength(1);
    const login = fetchMock.mock.calls.find(([url]) => url.endsWith("/login"))!;
    expect(JSON.parse(login[1]!.body as string)).toEqual({ authType: "WECHAT_SCAN", code: "once", state: "expected" });
    await act(async () => { finish({ token: "session", expireIn: 3600, customerId: "customer", isFirstLogin: false, isNeedBind: false, thirdPartyId: null }); });
    expect(auth.getState().isAuthenticated).toBe(true);
    expect(auth.getState().user?.id).toBe("customer");
    expect(screen.queryByText("auth.wechat_bind_title")).toBeNull();
    expect(closeAuthWindow).toHaveBeenCalled();
  });

  it("does not complete a session after the user cancels an in-flight exchange", async () => {
    const finish = deferredLogin();
    await start();
    act(() => callback("https://api.lynse.cn/auth/wechat/callback?code=once&state=expected"));
    fireEvent.click(screen.getByRole("button", { name: "auth.wechat_cancel" }));
    await act(async () => { finish({ token: "session", customerId: "customer" }); });
    expect(auth.getState().isAuthenticated).toBe(false);
  });

  it("ignores a previous attempt's callback after restarting", async () => {
    await start();
    const previous = callback;
    fireEvent.click(screen.getByRole("button", { name: "auth.wechat_cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "auth.wechat_login" }));
    await waitFor(() => expect(openAuthWindow).toHaveBeenCalledTimes(2));
    act(() => previous("https://api.lynse.cn/auth/wechat/callback?code=old&state=expected"));
    expect(fetchMock.mock.calls.every(([url]) => url.includes("/render"))).toBe(true);
  });

  it("rejects mismatched state without exchanging the code", async () => {
    await start();
    await act(async () => callback("https://api.lynse.cn/auth/wechat/callback?code=once&state=other"));
    expect(screen.getByText("wechat.callback_invalid_state")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(closeAuthWindow).toHaveBeenCalled();
  });

  it("does not authenticate against a newly selected server using the previous server's code", async () => {
    await start();
    const { api } = await import("@lynse/core/api");
    api().setBaseUrl("https://api.lynse.cn");
    await act(async () => callback("https://api.lynse.cn/auth/wechat/callback?code=once&state=expected"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(auth.getState().isAuthenticated).toBe(false);
  });

  it("shows the phone binding form for a new WeChat identity", async () => {
    const finish = deferredLogin();
    await start();
    act(() => callback("https://api.lynse.cn/auth/wechat/callback?code=once&state=expected"));
    await act(async () => { finish({ token: null, expireIn: null, customerId: null, isFirstLogin: true, isNeedBind: true, thirdPartyId: "new-identity" }); });
    expect(screen.getByText("auth.wechat_bind_title")).toBeTruthy();
    expect(auth.getState().isAuthenticated).toBe(false);
  });

  it("sends a BIND captcha and binds the scan openid with WECHAT_SCAN before persisting the session", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url.includes("/render")) return Response.json({ code: 200, data: AUTHORIZE_URL });
      if (url.includes("/captcha/sms?")) return Response.json({ code: 200, data: { success: true, cooldown: 60 } });
      if (url.includes("/bind?")) return Response.json({ code: 200, data: {
        token: "bound-session", expireIn: 3600, isFirstLogin: false, isNeedBind: false, customerId: "unified-customer", thirdPartyId: null,
      } });
      return Response.json({ code: 200, data: {
        token: null, expireIn: null, customerId: null, isFirstLogin: true, isNeedBind: true, thirdPartyId: "scan-openid",
      } });
    });
    await start();
    await act(async () => callback("https://api.lynse.cn/auth/wechat/callback?code=once&state=expected"));
    fireEvent.change(screen.getByPlaceholderText("auth.sms_phone_placeholder"), { target: { value: "13800000000" } });
    fireEvent.click(screen.getByRole("button", { name: "auth.sms_send_code" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.includes("/captcha/sms?"))).toBe(true));
    const captcha = new URL(fetchMock.mock.calls.find(([url]) => url.includes("/captcha/sms?"))![0]);
    expect(captcha.searchParams.get("actionType")).toBe("BIND");
    expect(auth.getState().isAuthenticated).toBe(false);

    fireEvent.change(screen.getByPlaceholderText("auth.sms_code_placeholder"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "auth.wechat_bind_submit" }));
    await waitFor(() => expect(auth.getState().isAuthenticated).toBe(true));
    const bind = new URL(fetchMock.mock.calls.find(([url]) => url.includes("/bind?"))![0]);
    expect(bind.origin).toBe("https://gapp.lynse.cn");
    expect(Object.fromEntries(bind.searchParams)).toEqual({
      thirdPartyId: "scan-openid", username: "13800000000", captchaCode: "123456", authType: "WECHAT_SCAN",
    });
    expect(auth.getState().user?.id).toBe("unified-customer");
    const { api } = await import("@lynse/core/api");
    expect(api().getToken()).toBe("bound-session");
  });

  it("explains an existing phone binding and lets the user return to phone sign-in", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockImplementation(async (url) => {
      if (url.includes("/render")) return Response.json({ code: 200, data: AUTHORIZE_URL });
      if (url.includes("/bind?")) return Response.json({ code: 500, msg: "error.phone.already.bind", data: null });
      return Response.json({ code: 200, data: { isNeedBind: true, thirdPartyId: "new-identity" } });
    });
    try {
      await start();
      await act(async () => callback("https://api.lynse.cn/auth/wechat/callback?code=once&state=expected"));
      fireEvent.change(screen.getByPlaceholderText("auth.sms_phone_placeholder"), { target: { value: "13800000000" } });
      fireEvent.change(screen.getByPlaceholderText("auth.sms_code_placeholder"), { target: { value: "123456" } });
      fireEvent.click(screen.getByRole("checkbox"));
      const submit = screen.getByRole("button", { name: "auth.wechat_bind_submit" }) as HTMLButtonElement;
      expect(submit.disabled).toBe(false);
      fireEvent.click(submit);

      await waitFor(() => expect(warning.mock.calls).toHaveLength(1));
      expect(auth.getState().isAuthenticated).toBe(false);
      expect(warning).toHaveBeenCalledWith("[wechat-bind] request failed", {
        server: "https://gapp.lynse.cn", status: 500, code: "error.phone.already.bind",
      });
      expect(screen.queryByText("auth.wechat_phone_already_bound")).toBeTruthy();
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(/13800000000|123456|new-identity/);

      fireEvent.click(screen.getByRole("button", { name: "auth.back_to_phone" }));
      expect(screen.queryByText("auth.wechat_bind_title")).toBeNull();
      expect(screen.getByRole("button", { name: "auth.sms_login_btn" })).toBeTruthy();
    } finally {
      warning.mockRestore();
    }
  });

  it("handles denied authorization without calling login", async () => {
    await start();
    await act(async () => callback("https://api.lynse.cn/auth/wechat/callback?error=access_denied&state=expected"));
    expect(screen.getByText("wechat.callback_denied")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
