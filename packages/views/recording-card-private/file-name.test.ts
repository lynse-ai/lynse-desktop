import { describe, expect, it } from "vitest";

import {
  recordingCardDisplayName,
  recordingCardDownloadName,
  recordingCardDuration,
  recordingCardRecordableTime,
} from "./file-name";

const file = {
  sn: 162,
  name: "c84714.raw",
  size: 11200,
  scene: 0,
  startTime: 1763300000,
  endTime: 1763300004,
  crc: "1263952520",
  frameSize: 80,
};

describe("recording card file names", () => {
  it("shows the RTC start time instead of the random device name", () => {
    const display = recordingCardDisplayName(file);
    expect(display).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(display).not.toContain("c84714");
  });

  it("keeps the device extension for web downloads and allows overriding it", () => {
    const display = recordingCardDisplayName(file);
    expect(recordingCardDownloadName(file)).toBe(`${display}.raw`);
    expect(recordingCardDownloadName(file, "wav")).toBe(`${display}.wav`);
  });

  it("falls back to the device name when the timestamp is missing", () => {
    const untimed = { ...file, startTime: 0 };
    expect(recordingCardDisplayName(untimed)).toBe("c84714.raw");
    expect(recordingCardDownloadName(untimed, "wav")).toBe("c84714.wav");
  });

  it("formats recording duration from the start and end timestamps", () => {
    expect(recordingCardDuration(file)).toBe("00:04");
    expect(recordingCardDuration({ ...file, endTime: file.startTime + 3725 })).toBe(
      "01:02:05",
    );
    expect(recordingCardDuration({ ...file, endTime: 0 })).toBeNull();
  });

  it("estimates recordable time from observed bitrate or frame size", () => {
    expect(recordingCardRecordableTime(2800 * 600, [file])).toEqual({
      hours: 0,
      minutes: 10,
    });
    expect(recordingCardRecordableTime(2000 * 60, [])).toEqual({
      hours: 0,
      minutes: 1,
    });
    expect(recordingCardRecordableTime(0, [file])).toBeNull();
  });
});
