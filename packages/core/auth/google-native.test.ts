import { afterEach, describe, expect, it } from "vitest";
import {
  configureGoogleNativeLogin,
  getGoogleNativeLoginConfig,
  googleNativeCallbackFromUrl,
  googleNativeRedirectUri,
  startGoogleNativeLogin,
} from "./google-native";

afterEach(() => {
  configureGoogleNativeLogin(null);
});

describe("configureGoogleNativeLogin", () => {
  it("gates on both values", () => {
    configureGoogleNativeLogin({ clientId: "id", firebaseApiKey: "key" });
    expect(getGoogleNativeLoginConfig()?.clientId).toBe("id");
    configureGoogleNativeLogin({ clientId: "id", firebaseApiKey: "" });
    expect(getGoogleNativeLoginConfig()).toBeNull();
    configureGoogleNativeLogin(null);
    expect(getGoogleNativeLoginConfig()).toBeNull();
  });
});

describe("startGoogleNativeLogin", () => {
  it("builds the consent URL against the loopback redirect", async () => {
    configureGoogleNativeLogin({ clientId: "abc.apps.googleusercontent.com", firebaseApiKey: "key" });
    const { authorizeUrl, redirectUri, state, verifier } = await startGoogleNativeLogin(45921);
    const url = new URL(authorizeUrl);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("abc.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:45921");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(redirectUri).toBe("http://127.0.0.1:45921");
    expect(state.length).toBeGreaterThan(20);
    expect(verifier.length).toBeGreaterThan(40);
  });

  it("refuses to run unconfigured", async () => {
    await expect(startGoogleNativeLogin(45921)).rejects.toThrow(/not configured/);
  });
});

describe("googleNativeCallbackFromUrl", () => {
  it("parses the code redirect bound to the attempt state", () => {
    expect(
      googleNativeCallbackFromUrl("http://127.0.0.1:45921/?state=st1&code=xyz&scope=openid", "st1"),
    ).toEqual({ kind: "code", code: "xyz" });
  });

  it("parses the denial error", () => {
    expect(
      googleNativeCallbackFromUrl("http://127.0.0.1:45921/?state=st1&error=access_denied", "st1"),
    ).toEqual({ kind: "error", error: "access_denied" });
  });

  it("rejects state mismatches, non-loopback hosts, and empty payloads", () => {
    // Forged/stale state.
    expect(
      googleNativeCallbackFromUrl("http://127.0.0.1:45921/?state=other&code=xyz", "st1"),
    ).toBeNull();
    expect(googleNativeCallbackFromUrl("http://127.0.0.1:45921/?code=xyz", "st1")).toBeNull();
    // Not a loopback redirect.
    expect(
      googleNativeCallbackFromUrl("https://evil.example/?state=st1&code=xyz", "st1"),
    ).toBeNull();
    // Neither code nor error.
    expect(googleNativeCallbackFromUrl("http://127.0.0.1:45921/?state=st1", "st1")).toBeNull();
    expect(googleNativeCallbackFromUrl("not a url", "st1")).toBeNull();
  });
});

describe("googleNativeRedirectUri", () => {
  it("formats the loopback redirect", () => {
    expect(googleNativeRedirectUri(27180)).toBe("http://127.0.0.1:27180");
  });
});
