import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient, setApiInstance, setApiTransportMode } from "../api/client";
import { createAuthStore } from "./index";
import { bindWechatPhone, desktopWechatAuthorizeUrl, loginByWechat, wechatSessionFromVo } from "./wechat";

function renderedUrl(appId = "server-app", state = "server-state"): string {
  return `https://open.weixin.qq.com/connect/qrconnect?${new URLSearchParams({
    appid: appId,
    state,
    redirect_uri: "https://api.lynse.cn/auth/wechat/callback?source=desktop",
    response_type: "code",
    scope: "snsapi_login",
  })}#wechat_redirect`;
}

function setup() {
  const saved = new Map<string, string>();
  const client = new ApiClient("https://api.lynse.cn");
  setApiInstance(client);
  setApiTransportMode("direct");
  const store = createAuthStore({
    api: client,
    storage: {
      getItem: (key) => saved.get(key) ?? null,
      setItem: (key, value) => { saved.set(key, value); },
      removeItem: (key) => { saved.delete(key); },
    },
  });
  const fetchMock = vi.fn(async (input: string) => Response.json({
    code: 200,
    data: input.includes("/render")
      ? renderedUrl(input.startsWith("https://gapp.") ? "test-app" : "prod-app")
      : { token: "session", customerId: "customer" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return { store, client, saved, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setApiTransportMode("proxy");
});

describe("desktop WeChat server selection", () => {
  it("preserves the complete website-app authorization URL supplied by the backend", () => {
    const rendered = renderedUrl();
    expect(desktopWechatAuthorizeUrl(rendered)).toBe(rendered);
    const url = new URL(desktopWechatAuthorizeUrl(rendered));
    expect(url.origin + url.pathname).toBe("https://open.weixin.qq.com/connect/qrconnect");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.lynse.cn/auth/wechat/callback?source=desktop");
    expect(url.searchParams.get("appid")).toBe("server-app");
    expect(url.searchParams.get("state")).toBe("server-state");
    expect(url.searchParams.get("scope")).toBe("snsapi_login");
    expect(url.hash).toBe("#wechat_redirect");
  });

  it("fetches configuration again after switching servers and sends login/bind to the selected server", async () => {
    const { store, client, saved, fetchMock } = setup();
    const production = await store.getState().startWechatLogin({ desktopQr: true });
    expect(new URL(production.authorizeUrl).searchParams.get("appid")).toBe("prod-app");

    const test = await store.getState().startWechatLogin({ apiUrl: "https://gapp.lynse.cn", desktopQr: true });
    expect(new URL(test.authorizeUrl).searchParams.get("appid")).toBe("test-app");
    expect(new URL(test.authorizeUrl).searchParams.get("redirect_uri")).toBe("https://api.lynse.cn/auth/wechat/callback?source=desktop");
    expect(saved.get("lynse_api_url")).toBe(client.getBaseUrl());
    expect(saved.get("lynse_wechat_state")).toBe(test.state);

    await loginByWechat("one-time-code", test.state);
    await bindWechatPhone({ thirdPartyId: "wechat-identity", phone: "13800000000", captchaCode: "123456" });
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0]![0]).toBe("https://api.lynse.cn/api/auth/render?authType=WECHAT_SCAN");
    expect(calls[1]![0]).toBe("https://gapp.lynse.cn/api/auth/render?authType=WECHAT_SCAN");
    expect(calls[2]![0]).toBe("https://gapp.lynse.cn/api/auth/login");
    expect(JSON.parse(calls[2]![1].body as string)).toEqual({
      authType: "WECHAT_SCAN", code: "one-time-code", state: "server-state",
    });
    expect(calls[3]![0]).toContain("https://gapp.lynse.cn/api/auth/bind?");
    expect(Object.fromEntries(new URL(calls[3]![0]).searchParams)).toEqual({
      authType: "WECHAT_SCAN", thirdPartyId: "wechat-identity", username: "13800000000", captchaCode: "123456",
    });
  });

  it("keeps the web authorization URL as rendered by the backend", async () => {
    const { store } = setup();
    const result = await store.getState().startWechatLogin();
    expect(result.authorizeUrl).toBe(renderedUrl("prod-app"));
  });

  it("rejects a response from the previous server when the server changes during render", async () => {
    const { store, client, fetchMock } = setup();
    fetchMock.mockImplementation(async () => {
      client.setBaseUrl("https://gapp.lynse.cn");
      return Response.json({ code: 200, data: renderedUrl() });
    });
    await expect(store.getState().startWechatLogin({ desktopQr: true })).rejects.toThrow("Server changed");
  });

  it("rejects missing state and unauthorized OAuth endpoints", async () => {
    expect(() => desktopWechatAuthorizeUrl(renderedUrl("app", ""))).toThrow();
    expect(() => desktopWechatAuthorizeUrl(renderedUrl().replace("open.weixin.qq.com", "other.example"))).toThrow();
    const { store, fetchMock } = setup();
    fetchMock.mockResolvedValue(Response.json({ code: 200, data: renderedUrl("app", "") }));
    await expect(store.getState().startWechatLogin()).rejects.toThrow("missing state");
  });

  it("rejects the mobile OAuth flow instead of converting its appid and callback into a QR flow", () => {
    const mobile = new URL(renderedUrl());
    mobile.pathname = "/connect/oauth2/authorize";
    mobile.searchParams.set("scope", "snsapi_userinfo");
    expect(() => desktopWechatAuthorizeUrl(mobile.toString())).toThrow();
    expect(() => desktopWechatAuthorizeUrl(renderedUrl().replace("snsapi_login", "snsapi_userinfo"))).toThrow();
    expect(() => desktopWechatAuthorizeUrl(renderedUrl().replace("response_type=code", "response_type=token"))).toThrow();
  });

  it("rejects an invalid callback without rewriting it", () => {
    const url = new URL(renderedUrl());
    url.searchParams.set("redirect_uri", "javascript:alert(1)");
    expect(() => desktopWechatAuthorizeUrl(url.toString())).toThrow();
  });

  it("uses the server customerId for both login and bind responses", () => {
    expect(wechatSessionFromVo({ token: "scan-token", customerId: "unified-customer", isNeedBind: false })).toEqual({
      accessToken: "scan-token", user: { id: "unified-customer", name: "", email: "" },
    });
    expect(wechatSessionFromVo({ token: "bind-token", customerId: "unified-customer", isFirstLogin: true, isNeedBind: false })?.user.id).toBe("unified-customer");
    expect(wechatSessionFromVo({ token: null, customerId: null, thirdPartyId: "scan-openid", isFirstLogin: true, isNeedBind: true })).toBeNull();
  });
});
