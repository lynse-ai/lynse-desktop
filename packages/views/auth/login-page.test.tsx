/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ApiClient, setApiInstance, setApiTransportMode } from "@lynse/core/api/client";
import { createAuthStore, registerAuthStore } from "@lynse/core/auth";
import { getDesktopAppApi } from "../app-update";
import { LoginPage } from "./login-page";
import { configureBuildChannel } from "../feature-flags";
import { changeLanguage } from "@lynse/core/i18n/react";

vi.mock("@lynse/core/i18n/react", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  changeLanguage: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: vi.fn() }));
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
const APPLE_AUTHORIZE_URL = "https://appleid.apple.com/auth/authorize?response_type=code%20id_token&response_mode=form_post&client_id=com.lynse.web&redirect_uri=https%3A%2F%2Fapi.lynse.cn%2Fapi%2Fauth%2Fapple%2Fcallback&scope=name%20email&state=expected";
let auth: ReturnType<typeof createAuthStore>;
let callback: (url: string) => void;
let appleCallback: ((url: string) => void) | undefined;
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
  appleCallback = undefined;
  vi.mocked(getDesktopAppApi).mockReturnValue({
    wechat: {
      openAuthWindow,
      closeAuthWindow,
      onAuthCallback: vi.fn(async (handler) => { callback = handler; return unlisten; }),
    },
    apple: {
      openAuthWindow,
      closeAuthWindow,
      onAuthCallback: vi.fn(async (handler) => { appleCallback = handler; return unlisten; }),
    },
  } as unknown as ReturnType<typeof getDesktopAppApi>);
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
      accountType: "PHONE",
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
      expect(screen.getByRole("button", { name: "auth.sms_send_code" })).toBeTruthy();
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

// The web shell (jsdom here: no desktopAPI bridge) leaves the page for the
// qrconnect URL instead of opening the desktop auth window. jsdom's location
// is unforgeable, so navigation itself can't be observed here — the pass
// branches live as pure-function tests in core/auth/wechat.test.ts, and this
// page-level test pins the pending branch the user actually sees.
const TUNNEL_AUTHORIZE_URL = "https://open.weixin.qq.com/connect/qrconnect?appid=wx3e6e41f00bb51c69&redirect_uri=https%3A%2F%2F5kt2352114jj.vicp.fun%2Fauth%2Flogin&state=expected&response_type=code&scope=snsapi_userinfo#wechat_redirect";

describe("web WeChat QR gate", () => {
  it("keeps the entry pending when the rendered redirect lands elsewhere", async () => {
    fetchMock.mockImplementation(async () => Response.json({ code: 200, data: TUNNEL_AUTHORIZE_URL }));
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "auth.wechat_qr_login" }));
    await waitFor(() =>
      expect(vi.mocked(toast)).toHaveBeenCalledWith("auth.wechat_qr_pending"),
    );
    // Only the render call happened — no exchange or bind traffic followed.
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes("/render"))).toBe(true);
  });
});

// Desktop Apple sign-in: the app-scanned QR entry made way for an Apple
// entry, and the authorize page opens in the embedded auth window whose
// backend landing (session fragment / bind identity / error key) is relayed
// back. The gapp API base in this suite pairs with the www.lynse.ai landing.
describe("desktop Apple sign-in", () => {
  // isWebPlatform() keys off the desktop bridge on window — present in the
  // real shell, absent in jsdom. Set it so the page renders the desktop
  // branch (QR entry hidden, Apple entry shown).
  beforeEach(() => {
    (window as unknown as { desktopAPI?: unknown }).desktopAPI = {};
  });
  afterEach(() => {
    delete (window as unknown as { desktopAPI?: Record<string, unknown> }).desktopAPI;
  });

  function startApple() {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "auth.more_login" }));
    expect(screen.queryByRole("button", { name: "auth.qr_login" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "auth.apple_login" }));
  }

  it("replaces the scan entry with Apple and opens the embedded auth window", async () => {
    fetchMock.mockImplementation(async () => Response.json({ code: 200, data: APPLE_AUTHORIZE_URL }));
    startApple();
    await waitFor(() => expect(openAuthWindow).toHaveBeenCalledTimes(1));
    expect(openAuthWindow).toHaveBeenCalledWith(APPLE_AUTHORIZE_URL, "https://www.lynse.ai");
  });

  it("signs in from the relayed success fragment", async () => {
    fetchMock.mockImplementation(async () => Response.json({ code: 200, data: APPLE_AUTHORIZE_URL }));
    startApple();
    await waitFor(() => expect(appleCallback).toBeDefined());
    await act(async () => appleCallback!("https://www.lynse.ai/app#token=apple-session&expireIn=3600"));
    expect(auth.getState().isAuthenticated).toBe(true);
    const { api } = await import("@lynse/core/api");
    expect(api().getToken()).toBe("apple-session");
  });

  it("shows the phone binding form for a first-time Apple identity", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (url.includes("/render")) return Response.json({ code: 200, data: APPLE_AUTHORIZE_URL });
      if (url.includes("/captcha/sms?")) return Response.json({ code: 200, data: { success: true, cooldown: 60 } });
      if (url.includes("/bind?")) return Response.json({ code: 200, data: {
        token: "bound-session", expireIn: 3600, isFirstLogin: false, isNeedBind: false, customerId: "unified-customer", thirdPartyId: null,
      } });
      return Response.json({ code: 200, data: {} });
    });
    startApple();
    await waitFor(() => expect(appleCallback).toBeDefined());
    await act(async () => appleCallback!("https://www.lynse.ai/bind?thirdPartyId=apple-sub-1"));
    expect(screen.getByText("auth.wechat_bind_title")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("auth.sms_phone_placeholder"), { target: { value: "13800000000" } });
    fireEvent.change(screen.getByPlaceholderText("auth.sms_code_placeholder"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "auth.wechat_bind_submit" }));
    await waitFor(() => expect(auth.getState().isAuthenticated).toBe(true));
    const bind = new URL(fetchMock.mock.calls.find(([url]) => url.includes("/bind?"))![0]);
    expect(bind.searchParams.get("authType")).toBe("APPLE");
    expect(bind.searchParams.get("thirdPartyId")).toBe("apple-sub-1");
  });

  it("surfaces backend landing errors and closes the auth window", async () => {
    fetchMock.mockImplementation(async () => Response.json({ code: 200, data: APPLE_AUTHORIZE_URL }));
    startApple();
    await waitFor(() => expect(appleCallback).toBeDefined());
    await act(async () => appleCallback!("https://www.lynse.ai/bind?error=error.apple.state.invalid"));
    expect(screen.getByText("auth.apple_err_state")).toBeTruthy();
    expect(closeAuthWindow).toHaveBeenCalled();
  });

  it("replaces desktop intl OAuth buttons with the waiting notice in-place so bottom text stays visible", async () => {
    localStorage.setItem("lynse_edition", "intl");
    const googleOpen = vi.fn(async () => {});
    const googleClose = vi.fn(async () => {});
    vi.mocked(getDesktopAppApi).mockReturnValue({
      google: {
        openAuthWindow: googleOpen,
        closeAuthWindow: googleClose,
        onAuthCallback: vi.fn(async () => unlisten),
      },
      apple: {
        openAuthWindow,
        closeAuthWindow,
        onAuthCallback: vi.fn(async () => unlisten),
      },
    } as unknown as ReturnType<typeof getDesktopAppApi>);

    try {
      render(<LoginPage />);
      const googleBtn = screen.getByTestId("google-login");
      const siteSwitcher = screen.getByLabelText("auth.server_region");
      fireEvent.click(googleBtn);

      await waitFor(() => expect(googleOpen).toHaveBeenCalledTimes(1));
      const waiting = screen.getByTestId("oauth-waiting");
      expect(screen.getByText("auth.google_waiting")).toBeTruthy();
      expect(screen.getByText("auth.sso_waiting_hint")).toBeTruthy();
      expect(screen.getByRole("button", { name: "auth.wechat_cancel" })).toBeTruthy();
      expect(screen.getAllByTestId("oauth-waiting")).toHaveLength(1);
      // Waiting notice replaces the OAuth buttons above the site switcher instead of pushing past it.
      expect(screen.queryByTestId("google-login")).toBeNull();
      expect(waiting.compareDocumentPosition(siteSwitcher)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

      fireEvent.click(screen.getByRole("button", { name: "auth.wechat_cancel" }));
      expect(googleClose).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("oauth-waiting")).toBeNull();
      expect(screen.getByTestId("google-login")).toBeTruthy();
    } finally {
      localStorage.removeItem("lynse_edition");
    }
  });

  it("renders server region switcher and allows switching between CN and Global editions", async () => {
    localStorage.clear();
    render(<LoginPage />);
    const trigger = screen.getByLabelText("auth.server_region");
    expect(trigger).toBeTruthy();

    // Click trigger to open dropdown, then switch to intl
    fireEvent.click(trigger);
    fireEvent.click(screen.getByText("auth.region_intl"));
    await waitFor(() => {
      expect(localStorage.getItem("lynse_edition")).toBe("intl");
      expect(localStorage.getItem("lynse_api_url")).toBe("https://api-en.lynse.ai");
      expect(screen.getByPlaceholderText("auth.email_placeholder")).toBeTruthy();
    });

    // Click trigger again, then switch back to cn
    fireEvent.click(screen.getByLabelText("auth.server_region"));
    fireEvent.click(screen.getByText("auth.region_cn"));
    await waitFor(() => {
      expect(localStorage.getItem("lynse_edition")).toBe("cn");
      expect(localStorage.getItem("lynse_api_url")).toBe("https://api.lynse.cn");
      expect(screen.getByPlaceholderText("auth.sms_phone_placeholder")).toBeTruthy();
      expect(changeLanguage).toHaveBeenCalledWith("zh-Hans");
    });
  });

  describe("progressive single-input (Muse style) flow", () => {
    it("identifies phone number, requires agreement, sends SMS captcha, morphs into code input and auto-submits on 6 digits", async () => {
      fetchMock.mockImplementation(async (url) => {
        if (url.includes("/captcha/sms?")) return Response.json({ code: 200, data: { success: true, cooldown: 60 } });
        if (url.includes("/login")) return Response.json({ code: 200, data: { token: "phone-token", customerId: "c1" } });
        return Response.json({ code: 200, data: {} });
      });

      render(<LoginPage />);
      const accountInput = screen.getByPlaceholderText("auth.sms_phone_placeholder");
      fireEvent.change(accountInput, { target: { value: "13800000000" } });

      // Clicking send before agreement shows error
      const sendBtn = screen.getByRole("button", { name: "auth.sms_send_code" });
      fireEvent.click(sendBtn);
      expect(fetchMock).not.toHaveBeenCalled();

      // Check agreement
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(sendBtn);

      // Verifies captcha is requested
      await waitFor(() => {
        expect(fetchMock.mock.calls.some(([url]) => url.includes("/captcha/sms?"))).toBe(true);
      });
      const captchaCall = fetchMock.mock.calls.find(([url]) => url.includes("/captcha/sms?"))!;
      expect(captchaCall[0]).toContain("phone=13800000000");

      // Input morphs into verification code input (step: code)
      await waitFor(() => {
        expect(screen.getByPlaceholderText("auth.sms_code_placeholder")).toBeTruthy();
        expect(screen.getByText("auth.edit_account")).toBeTruthy();
      });

      // Entering 6 digits triggers auto-submit
      const codeInput = screen.getByPlaceholderText("auth.sms_code_placeholder");
      fireEvent.change(codeInput, { target: { value: "123456" } });

      await waitFor(() => {
        expect(auth.getState().isAuthenticated).toBe(true);
      });
      expect(fetchMock.mock.calls.some(([url]) => url.endsWith("/login"))).toBe(true);
    });

    it("identifies email via @, sends email captcha, and allows editing account back to step 1", async () => {
      fetchMock.mockImplementation(async (url) => {
        if (url.includes("/captcha/email?")) return Response.json({ code: 200, data: { success: true, cooldown: 60 } });
        return Response.json({ code: 200, data: {} });
      });

      render(<LoginPage />);
      const accountInput = screen.getByPlaceholderText("auth.sms_phone_placeholder");
      fireEvent.change(accountInput, { target: { value: "user@example.com" } });
      fireEvent.click(screen.getByRole("checkbox"));

      const sendBtn = screen.getByRole("button", { name: "auth.sms_send_code" });
      fireEvent.click(sendBtn);

      // Verifies email captcha is called
      await waitFor(() => {
        expect(fetchMock.mock.calls.some(([url]) => url.includes("/captcha/email?"))).toBe(true);
      });
      const captchaCall = fetchMock.mock.calls.find(([url]) => url.includes("/captcha/email?"))!;
      expect(captchaCall[0]).toContain("email=user%40example.com");

      // In step 2, click Edit to return to step 1
      await waitFor(() => {
        expect(screen.getByPlaceholderText("auth.sms_code_placeholder")).toBeTruthy();
      });
      fireEvent.click(screen.getByText("auth.edit_account"));

      // Returns to step 1 with value preserved
      expect(screen.getByPlaceholderText("auth.sms_phone_placeholder")).toHaveProperty("value", "user@example.com");
    });
  });
});

describe("web verification-code sign-in", () => {
  afterEach(() => localStorage.removeItem("lynse_edition"));

  it("lets a CN user change from a phone to an email during the phone resend cooldown", async () => {
    localStorage.setItem("lynse_edition", "cn");
    fetchMock.mockImplementation(async (url) => Response.json({
      code: 200,
      data: url.endsWith("/login")
        ? { token: "email-session", customerId: "email-customer" }
        : { success: true, cooldown: 60 },
    }));
    render(<LoginPage hideMoreLogin />);

    const account = () => screen.getByPlaceholderText("auth.sms_phone_placeholder");
    const code = () => screen.getByPlaceholderText("auth.sms_code_placeholder");
    const send = () => fireEvent.click(screen.getByRole("button", { name: "auth.sms_send_code" }));
    const apple = screen.getByRole("button", { name: "auth.apple_login" });
    const wechat = screen.getByRole("button", { name: "auth.wechat_qr_login" });
    expect(screen.queryByRole("button", { name: "auth.more_login" })).toBeNull();
    expect(apple.compareDocumentPosition(wechat)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(wechat.compareDocumentPosition(account())).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(account().getAttribute("inputmode")).toBe("text");
    expect(screen.queryByPlaceholderText("auth.sms_code_placeholder")).toBeNull();
    fireEvent.change(account(), { target: { value: "+86 138 0000 0000" } });
    fireEvent.click(screen.getByRole("checkbox"));
    send();
    await screen.findByPlaceholderText("auth.sms_code_placeholder");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/captcha/sms?phone=13800000000");
    fireEvent.change(code(), { target: { value: "123" } });
    fireEvent.click(screen.getByText("auth.edit_account"));
    send();
    expect(code()).toHaveProperty("value", "");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("auth.edit_account"));
    fireEvent.change(account(), { target: { value: "demo@example.test" } });
    send();
    await screen.findByPlaceholderText("auth.sms_code_placeholder");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/captcha/email?email=demo%40example.test");
    fireEvent.change(code(), { target: { value: "654321" } });
    await waitFor(() => expect(auth.getState().user?.id).toBe("email-customer"));
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({
      authType: "EMAIL_CODE", username: "demo@example.test", captchaCode: "654321",
    }));
  });

  it("accepts only email on the international site", async () => {
    localStorage.setItem("lynse_edition", "intl");
    fetchMock.mockResolvedValue(Response.json({ code: 200, data: { success: true, cooldown: 60 } }));
    render(<LoginPage />);

    const account = screen.getByPlaceholderText("auth.email_placeholder");
    const send = screen.getByRole("button", { name: "auth.sms_send_code" });
    fireEvent.change(account, { target: { value: "13800000000" } });
    expect(send).toHaveProperty("disabled", true);
    fireEvent.keyDown(account, { key: "Enter" });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(account, { target: { value: "demo@example.test" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(send);
    await screen.findByPlaceholderText("auth.sms_code_placeholder");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/captcha/email?");
  });
});
