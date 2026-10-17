import { describe, expect, it } from "vitest";
import {
  isLocalFileId,
  localRecordToTranscription,
  localRecordToWorkspaceItem,
  mergeCloudAndLocalFiles,
  migrateSttProviderConfig,
  resolveSttProvider,
  providerModelId,
  findModelStatus,
  FUNASR_MODEL_ID,
  VIBEVOICE_MODEL_ID,
  DEFAULT_WHISPER_MODEL,
  DEFAULT_QWEN3_MODEL,
} from "./local-transcription";
import type { SttModelInfo, TranscribeConfig } from "./local-transcription";
import type { LocalTranscriptionRecord, WorkspaceItem } from "./types";

const localRecord: LocalTranscriptionRecord = {
  id: "local:abc",
  title: "meeting.wav",
  sourcePath: "/tmp/meeting.wav",
  createdAt: "2026-07-04T08:00:00.000Z",
  updatedAt: "2026-07-04T08:05:00.000Z",
  transcriptText: "大家好，今天讨论离线转写。",
  status: "completed",
  durationMs: 125000,
  engine: "funasr",
  segments: [
    {
      id: "seg-1",
      text: "大家好，今天讨论离线转写。",
      startMs: 120,
      endMs: 2680,
      speakerId: "spk-1",
      speakerName: "张三",
      rawSpeaker: "0",
    },
  ],
};

describe("local transcription helpers", () => {
  it("detects local file ids by prefix", () => {
    expect(isLocalFileId("local:abc")).toBe(true);
    expect(isLocalFileId("cloud-file")).toBe(false);
    expect(isLocalFileId(null)).toBe(false);
  });

  it("converts a local record into a workspace file row", () => {
    expect(localRecordToWorkspaceItem(localRecord)).toEqual({
      id: "local:abc",
      type: "file",
      title: "meeting.wav",
      createdAt: "2026-07-04T08:00:00.000Z",
      updatedAt: "2026-07-04T08:05:00.000Z",
      folderId: "__local_transcriptions__",
      localStatus: "completed",
      transcriptionCompleted: true,
      durationSeconds: 125,
    });
  });

  it("maps local transcript segments to the existing transcription shape", () => {
    expect(localRecordToTranscription(localRecord)).toEqual({
      id: "local:abc",
      fileId: "local:abc",
      taskId: "local-funasr",
      content: "大家好，今天讨论离线转写。",
      records: [
        {
          id: "seg-1",
          speakerName: "张三",
          beginTimeStr: "00:00:00",
          beginTime: 120,
          endTime: 2680,
          text: "大家好，今天讨论离线转写。",
        },
      ],
    });
  });

  it("marks failed and in-progress local records in workspace rows", () => {
    expect(localRecordToWorkspaceItem({
      ...localRecord,
      status: "failed",
      error: "model failed",
    }).localStatus).toBe("failed");

    expect(localRecordToWorkspaceItem({
      ...localRecord,
      status: "transcribing",
      progressPhase: "transcribing",
    }).localStatus).toBe("transcribing");

    // Local rows carry no display tags — the card badge is derived from the id.
    expect(localRecordToWorkspaceItem({
      ...localRecord,
      status: "failed",
    }).tags).toBeUndefined();
  });

  it("normalizes audio-only records so they never read as transcribed", () => {
    // Pure live recordings now persist as `recorded`…
    const recorded = localRecordToWorkspaceItem({
      ...localRecord,
      transcriptText: "",
      segments: [],
      status: "recorded",
    });
    expect(recorded.localStatus).toBe("recorded");
    expect(recorded.transcriptionCompleted).toBe(false);

    // …while legacy stores already hold them as completed-with-empty-text.
    const legacy = localRecordToWorkspaceItem({
      ...localRecord,
      transcriptText: "  ",
      segments: [],
      status: "completed",
    });
    expect(legacy.localStatus).toBe("recorded");
    expect(legacy.transcriptionCompleted).toBe(false);

    // A real transcript keeps its completed status.
    expect(localRecordToWorkspaceItem(localRecord).transcriptionCompleted).toBe(true);
  });

  it("falls back to transcript text when FunASR returns no sentence segments", () => {
    const transcription = localRecordToTranscription({
      ...localRecord,
      transcriptText: "<|zh|><|NEUTRAL|><|Speech|><|woitn|>大家好，今天讨论离线转写。",
      segments: [],
    });

    expect(transcription.content).toBe("大家好，今天讨论离线转写。");
    expect(transcription.records).toEqual([
      {
        id: "seg-1",
        speakerName: "发言人1",
        beginTimeStr: "00:00:00",
        beginTime: 0,
        endTime: undefined,
        text: "大家好，今天讨论离线转写。",
      },
    ]);
  });

  it("merges local files before cloud files without mutating either list", () => {
    const cloudFiles: WorkspaceItem[] = [
      {
        id: "cloud-1",
        type: "file",
        title: "cloud.wav",
        createdAt: "2026-07-03T08:00:00.000Z",
        updatedAt: "2026-07-03T08:00:00.000Z",
      },
    ];

    const result = mergeCloudAndLocalFiles(cloudFiles, [localRecord]);

    expect(result.map((item) => item.id)).toEqual(["local:abc", "cloud-1"]);
    expect(cloudFiles).toHaveLength(1);
  });
});

describe("STT provider config", () => {
  it("migrates legacy funasr configs without a provider tag", () => {
    expect(migrateSttProviderConfig({ expected_speakers: 2, hotword_package_id: "h1" })).toEqual({
      provider: "funasr",
      expected_speakers: 2,
      hotword_package_id: "h1",
    });
    expect(migrateSttProviderConfig(null)).toBeNull();
  });

  it("normalizes whisper and vibeasr configs", () => {
    expect(migrateSttProviderConfig({ provider: "whisper" })).toEqual({
      provider: "whisper",
      model: DEFAULT_WHISPER_MODEL,
      campp_diarization: false,
      expected_speakers: null,
      hotword_package_id: null,
    });
    expect(migrateSttProviderConfig({ provider: "vibeasr" })).toEqual({
      provider: "vibeasr",
      hotword_package_id: null,
    });
  });

  it("normalizes qwen3 configs and fills the default model", () => {
    expect(migrateSttProviderConfig({ provider: "qwen3" })).toEqual({
      provider: "qwen3",
      model: DEFAULT_QWEN3_MODEL,
      hotword_package_id: null,
    });
    expect(migrateSttProviderConfig({ provider: "qwen3", model: "qwen3-asr-0.6b-4bit" })).toEqual({
      provider: "qwen3",
      model: "qwen3-asr-0.6b-4bit",
      hotword_package_id: null,
    });
  });

  it("resolves per-note > language > default > desktop-provided fallback", () => {
    const config: TranscribeConfig = {
      default: { provider: "qwen3" },
      per_language: { zh: { provider: "whisper", model: "small-q5_1" } },
    };
    expect(resolveSttProvider(config, null, null).provider).toBe("qwen3");
    expect(resolveSttProvider(config, "zh", null).provider).toBe("whisper");
    expect(resolveSttProvider(config, "en", { provider: "vibeasr" }).provider).toBe("vibeasr");
    // An engine the user configured is never overridden by the locale default.
    expect(resolveSttProvider(config, null, null, { provider: "funasr" }).provider).toBe("qwen3");
    // With no config at all the desktop decides: it is the only side that knows
    // the compile target and the UI language.
    expect(
      resolveSttProvider({ per_language: {} }, null, null, { provider: "funasr" }).provider,
    ).toBe("funasr");
    // And when it cannot answer (web build, or an app predating the command),
    // fall back to the engine that runs everywhere — not to `qwen3`, which used
    // to be hardcoded here and cannot run at all outside Apple Silicon.
    expect(resolveSttProvider({ per_language: {} }, null, null).provider).toBe("whisper");
  });

  it("derives the backing model id per engine", () => {
    expect(providerModelId({ provider: "qwen3" })).toBe(DEFAULT_QWEN3_MODEL);
    expect(providerModelId({ provider: "qwen3", model: "qwen3-asr-0.6b-4bit" })).toBe("qwen3-asr-0.6b-4bit");
    expect(providerModelId({ provider: "funasr" })).toBe(FUNASR_MODEL_ID);
    expect(providerModelId({ provider: "whisper", model: "medium-q5_0" })).toBe("medium-q5_0");
    expect(providerModelId({ provider: "vibeasr" })).toBe(VIBEVOICE_MODEL_ID);
  });

  it("finds the install status for a resolved provider", () => {
    const models: SttModelInfo[] = [
      { provider: "funasr", id: FUNASR_MODEL_ID, label: "f", sizeBytes: 0, status: "installed", modelDir: "/x" },
      { provider: "whisper", id: "small-q5_1", label: "w", sizeBytes: 1, status: "not_installed", modelDir: "/y" },
    ];
    const resolved = resolveSttProvider({ default: { provider: "whisper", model: "small-q5_1" }, per_language: {} }, null, null);
    expect(findModelStatus(models, resolved)?.status).toBe("not_installed");
  });
});
