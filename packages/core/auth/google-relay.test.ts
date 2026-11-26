import { describe, expect, it } from "vitest";
import {
  GOOGLE_RELAY_DONE_PATH,
  GOOGLE_RELAY_PATH,
  buildGoogleRelayUrl,
  googleRelayLandingFromUrl,
  webOriginForApi,
} from "./google";

describe("webOriginForApi", () => {
  it("pairs the API host with its site origin", () => {
    expect(webOriginForApi("https://api.lynse.cn")).toBe("https://www.lynse.cn");
    expect(webOriginForApi("https://api-en.lynse.ai")).toBe("https://www.lynse.ai");
    expect(webOriginForApi("https://gapp.lynse.cn")).toBe("https://www.lynse.ai");
    // Dev/staging APIs fall back to the CN site.
    expect(webOriginForApi("https://api-staging.example.test")).toBe("https://www.lynse.cn");
    expect(webOriginForApi("not a url")).toBe("https://www.lynse.cn");
  });
});

describe("buildGoogleRelayUrl", () => {
  it("points the auth window at the relay page with the nonce", () => {
    // Production web deployments serve the app under /app — the window must
    // open through that prefix or nginx 404s it.
    expect(buildGoogleRelayUrl("https://www.lynse.ai", "n-abc")).toBe(
      "https://www.lynse.ai/app/auth/google-desktop?nonce=n-abc",
    );
  });
});

describe("googleRelayLandingFromUrl", () => {
  const origin = "https://www.lynse.ai";
  const done = (fragment: string, query: string) =>
    `${origin}${GOOGLE_RELAY_DONE_PATH}${query ? `?${query}` : ""}${fragment ? `#${fragment}` : ""}`;

  it("parses the identity token from the done fragment", () => {
    expect(
      googleRelayLandingFromUrl(done("identityToken=jwt.a.b&nonce=n1", ""), "n1"),
    ).toEqual({ kind: "identity", identityToken: "jwt.a.b", nonce: "n1" });
    expect(
      googleRelayLandingFromUrl(done("identityToken=jwt", "nonce=n1"), "n1"),
    ).toEqual({ kind: "identity", identityToken: "jwt", nonce: "n1" });
  });

  it("parses the relay page's error key", () => {
    expect(
      googleRelayLandingFromUrl(done("", "error=auth%2Fpopup-blocked&nonce=n1"), "n1"),
    ).toEqual({ kind: "error", error: "auth/popup-blocked", nonce: "n1" });
  });

  it("rejects anything without the expected nonce or an outcome marker", () => {
    // Nonce mismatch — a replayed or forged landing.
    expect(googleRelayLandingFromUrl(done("identityToken=jwt&nonce=n1", ""), "n2")).toBeNull();
    expect(googleRelayLandingFromUrl(done("identityToken=jwt", ""), "n1")).toBeNull();
    // No outcome marker (bare done navigation).
    expect(googleRelayLandingFromUrl(done("", "nonce=n1"), "n1")).toBeNull();
    // Not even the done path.
    expect(
      googleRelayLandingFromUrl(`${origin}${GOOGLE_RELAY_PATH}?nonce=n1`, "n1"),
    ).toBeNull();
    expect(googleRelayLandingFromUrl("not a url", "n1")).toBeNull();
  });
});
