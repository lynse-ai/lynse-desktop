import { describe, expect, it } from "vitest";
import {
  appleLandingFromUrl,
  appleWebLandingOrigin,
  sessionFromAppleFragment,
} from "./apple";

describe("appleWebLandingOrigin", () => {
  it("pairs the API host with its site origin", () => {
    expect(appleWebLandingOrigin("https://api.lynse.cn")).toBe("https://www.lynse.cn");
    expect(appleWebLandingOrigin("https://gapp.lynse.cn")).toBe("https://www.lynse.ai");
    // Dev/staging APIs fall back to the CN site.
    expect(appleWebLandingOrigin("https://api-staging.example.test")).toBe("https://www.lynse.cn");
  });

  it("falls back on a malformed base URL", () => {
    expect(appleWebLandingOrigin("not a url")).toBe("https://www.lynse.cn");
  });
});

describe("appleLandingFromUrl", () => {
  it("parses the session token from the success fragment", () => {
    expect(appleLandingFromUrl("https://www.lynse.cn/app#token=tok123&expireIn=3600")).toEqual({
      kind: "session",
      token: "tok123",
    });
  });

  it("parses the bind identity and the error key from the query", () => {
    expect(appleLandingFromUrl("https://www.lynse.cn/bind?thirdPartyId=sub-1")).toEqual({
      kind: "bind",
      thirdPartyId: "sub-1",
    });
    expect(appleLandingFromUrl("https://www.lynse.cn/bind?error=error.apple.state.invalid")).toEqual({
      kind: "error",
      key: "error.apple.state.invalid",
    });
  });

  it("returns null for URLs without any landing marker", () => {
    expect(appleLandingFromUrl("https://www.lynse.cn/app")).toBeNull();
    expect(appleLandingFromUrl("https://www.lynse.cn/app#section")).toBeNull();
    expect(appleLandingFromUrl("https://www.lynse.cn/bind?thirdPartyId=")).toBeNull();
    expect(appleLandingFromUrl("not a url")).toBeNull();
  });
});

describe("sessionFromAppleFragment", () => {
  it("builds a token-only session", () => {
    expect(sessionFromAppleFragment("tok")).toEqual({
      accessToken: "tok",
      user: { id: "", name: "", email: "" },
    });
  });
});
