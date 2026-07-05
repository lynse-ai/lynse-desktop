import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  LocalHotwordPackageStore,
  LocalTranscriptionStore,
  applyHotwordReplacements,
  buildFunasrScriptArgs,
  createCompletedLocalRecord,
  createQueuedLocalRecord,
  deleteLocalAsrModel,
  getLocalAsrModelStatus,
  getLocalMediaUrlForRecord,
  normalizeFunasrOutput,
  parseFunasrJsonFromStdout,
} from "./local-transcription";

describe("local transcription main helpers", () => {
  it("normalizes FunASR JSON into text and timed segments", () => {
    const output = normalizeFunasrOutput({
      text: "第一句。第二句。",
      sentence_info: [
        { start: 100, end: 1200, sentence: "第一句。", spk: 0 },
        { start: 1300, end: 2400, text: "第二句。", spk: 1 },
      ],
    });

    expect(output).toEqual({
      text: "第一句。第二句。",
      segments: [
        {
          id: "seg-1",
          text: "第一句。",
          startMs: 100,
          endMs: 1200,
          speakerId: "spk-1",
          speakerName: "发言人1",
          rawSpeaker: "0",
        },
        {
          id: "seg-2",
          text: "第二句。",
          startMs: 1300,
          endMs: 2400,
          speakerId: "spk-2",
          speakerName: "发言人2",
          rawSpeaker: "1",
        },
      ],
    });
  });

  it("cleans model tags while normalizing FunASR segment text", () => {
    const output = normalizeFunasrOutput({
      text: "<|zh|><|NEUTRAL|><|Speech|><|woitn|>大家好",
      sentence_info: [
        { start: 0, end: 1000, text: "<|zh|><|NEUTRAL|><|Speech|><|woitn|>大家好", spk: "A" },
      ],
    });

    expect(output).toEqual({
      text: "大家好",
      segments: [
        {
          id: "seg-1",
          text: "大家好",
          startMs: 0,
          endMs: 1000,
          speakerId: "spk-A",
          speakerName: "发言人A",
          rawSpeaker: "A",
        },
      ],
    });
  });

  it("parses the last JSON line from FunASR stdout with startup logs", () => {
    expect(parseFunasrJsonFromStdout([
      "funasr version: 1.2.7.",
      "loading model...",
      "{\"text\":\"会议开始\",\"sentence_info\":[]}",
    ].join("\n"))).toEqual({
      text: "会议开始",
      sentence_info: [],
    });
  });

  it("creates a completed local record with a local id and source filename title", () => {
    const record = createCompletedLocalRecord({
      sourcePath: "/tmp/audio/meeting.wav",
      transcriptText: "hello",
      segments: [],
      now: "2026-07-04T10:00:00.000Z",
      randomId: () => "abc123",
    });

    expect(record).toMatchObject({
      id: "local:abc123",
      title: "meeting.wav",
      sourcePath: "/tmp/audio/meeting.wav",
      createdAt: "2026-07-04T10:00:00.000Z",
      updatedAt: "2026-07-04T10:00:00.000Z",
      transcriptText: "hello",
      status: "completed",
      progressPhase: "completed",
      engine: "funasr",
      segments: [],
    });
  });

  it("creates a queued local record before transcription starts", () => {
    const record = createQueuedLocalRecord({
      sourcePath: "/tmp/audio/meeting.wav",
      expectedSpeakers: 2,
      hotwordPackageId: "pkg-1",
      now: "2026-07-04T10:00:00.000Z",
      randomId: () => "queued",
    });

    expect(record).toMatchObject({
      id: "local:queued",
      title: "meeting.wav",
      sourcePath: "/tmp/audio/meeting.wav",
      status: "queued",
      progressPhase: "queued",
      expectedSpeakers: 2,
      hotwordPackageId: "pkg-1",
      transcriptText: "",
      segments: [],
    });
  });

  it("persists local records in newest-first order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lynse-local-transcription-"));
    try {
      const store = new LocalTranscriptionStore(dir);
      const older = createCompletedLocalRecord({
        sourcePath: "/tmp/older.wav",
        transcriptText: "older",
        segments: [],
        now: "2026-07-04T08:00:00.000Z",
        randomId: () => "older",
      });
      const newer = createCompletedLocalRecord({
        sourcePath: "/tmp/newer.wav",
        transcriptText: "newer",
        segments: [],
        now: "2026-07-04T09:00:00.000Z",
        randomId: () => "newer",
      });

      await store.save(older);
      await store.save(newer);

      expect((await store.list()).map((record) => record.id)).toEqual([
        "local:newer",
        "local:older",
      ]);
      expect(await store.get("local:older")).toEqual(older);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("updates and removes local records for failed tasks and retry flows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lynse-local-transcription-update-"));
    try {
      const store = new LocalTranscriptionStore(dir);
      const record = createQueuedLocalRecord({
        sourcePath: "/tmp/meeting.wav",
        now: "2026-07-04T08:00:00.000Z",
        randomId: () => "task",
      });
      await store.save(record);

      await store.update(record.id, {
        status: "failed",
        progressPhase: "failed",
        error: "model failed",
        updatedAt: "2026-07-04T08:01:00.000Z",
      });

      expect(await store.get(record.id)).toMatchObject({
        status: "failed",
        progressPhase: "failed",
        error: "model failed",
      });

      await store.remove(record.id);
      expect(await store.get(record.id)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports local ASR model as not installed until the ready marker exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lynse-local-asr-model-"));
    try {
      await expect(getLocalAsrModelStatus(dir)).resolves.toMatchObject({
        status: "not_installed",
        modelDir: join(dir, "local-asr-models", "funasr"),
      });

      await mkdir(join(dir, "local-asr-models", "funasr"), { recursive: true });
      await mkdir(join(dir, "local-asr-models", "funasr", ".ready"), { recursive: true });

      await expect(getLocalAsrModelStatus(dir)).resolves.toMatchObject({
        status: "installed",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deletes the managed local ASR model directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lynse-local-asr-delete-"));
    try {
      await mkdir(join(dir, "local-asr-models", "funasr", ".ready"), { recursive: true });

      await deleteLocalAsrModel(dir);

      await expect(getLocalAsrModelStatus(dir)).resolves.toMatchObject({
        status: "not_installed",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds FunASR script args for model download and transcription", () => {
    expect(buildFunasrScriptArgs({
      mode: "download",
      scriptPath: "/app/funasr_transcribe.py",
      modelDir: "/models/funasr",
    })).toEqual(["/app/funasr_transcribe.py", "--download-models", "--model-dir", "/models/funasr"]);

    expect(buildFunasrScriptArgs({
      mode: "transcribe",
      scriptPath: "/app/funasr_transcribe.py",
      modelDir: "/models/funasr",
      audioPath: "/audio/meeting.wav",
      expectedSpeakers: 2,
      hotwordText: "灵光记 Lynse",
    })).toEqual([
      "/app/funasr_transcribe.py",
      "/audio/meeting.wav",
      "--model-dir",
      "/models/funasr",
      "--expected-speakers",
      "2",
      "--hotword",
      "灵光记 Lynse",
    ]);
  });

  it("applies explicit hotword replacements conservatively", () => {
    expect(applyHotwordReplacements("今天讨论林思的本地转写", [
      { term: "林思", replacement: "Lynse", enabled: true },
      { term: "不会出现", replacement: "ignored", enabled: false },
    ])).toBe("今天讨论Lynse的本地转写");
  });

  it("persists local hotword packages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lynse-local-hotwords-"));
    try {
      const store = new LocalHotwordPackageStore(dir);
      await store.save({
        id: "pkg-1",
        name: "默认热词",
        enabled: true,
        createdAt: "2026-07-04T08:00:00.000Z",
        updatedAt: "2026-07-04T08:00:00.000Z",
        terms: [{ term: "灵光记", replacement: "灵光记", enabled: true }],
      });

      expect(await store.list()).toHaveLength(1);
      await store.remove("pkg-1");
      expect(await store.list()).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("creates local media URLs only for known records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lynse-local-media-"));
    try {
      const store = new LocalTranscriptionStore(dir);
      const record = createCompletedLocalRecord({
        sourcePath: "/tmp/audio/meeting.wav",
        transcriptText: "hello",
        segments: [],
        randomId: () => "media",
      });
      await store.save(record);

      await expect(getLocalMediaUrlForRecord(store, "local:media")).resolves.toBe(
        "local-media://local%3Amedia",
      );
      await expect(getLocalMediaUrlForRecord(store, "local:missing")).resolves.toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
