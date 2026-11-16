import { describe, expect, it } from "vitest";
import { buildRecordingCardManageUrl, RECORDING_CARD_MANAGE_PATH } from "./manage-url";

/**
 * The desktop must open the web deployment fronting the SAME account system
 * the user is signed into (sessions are per-origin localStorage), so the
 * API host → web origin pairing is a hard contract.
 */
describe("buildRecordingCardManageUrl", () => {
  it("maps the CN production API to the CN web site", () => {
    expect(buildRecordingCardManageUrl("https://api.lynse.cn")).toBe(
      `https://www.lynse.cn/app${RECORDING_CARD_MANAGE_PATH}`,
    );
  });

  it("maps the test and intl APIs to the lynse.ai web site", () => {
    expect(buildRecordingCardManageUrl("https://gapp.lynse.cn")).toBe(
      `https://www.lynse.ai/app${RECORDING_CARD_MANAGE_PATH}`,
    );
    expect(buildRecordingCardManageUrl("https://api-en.lynse.ai")).toBe(
      `https://www.lynse.ai/app${RECORDING_CARD_MANAGE_PATH}`,
    );
  });

  it("falls back to the CN site for unknown or unparseable bases", () => {
    expect(buildRecordingCardManageUrl("https://unknown.example.com")).toBe(
      `https://www.lynse.cn/app${RECORDING_CARD_MANAGE_PATH}`,
    );
    expect(buildRecordingCardManageUrl("")).toBe(
      `https://www.lynse.cn/app${RECORDING_CARD_MANAGE_PATH}`,
    );
    expect(buildRecordingCardManageUrl("not a url")).toBe(
      `https://www.lynse.cn/app${RECORDING_CARD_MANAGE_PATH}`,
    );
  });

  it("keeps a trailing path or port out of the origin match", () => {
    // Ports/paths change the host key → default, never a partial match.
    expect(buildRecordingCardManageUrl("https://api.lynse.cn:8443")).toBe(
      `https://www.lynse.cn/app${RECORDING_CARD_MANAGE_PATH}`,
    );
  });
});
