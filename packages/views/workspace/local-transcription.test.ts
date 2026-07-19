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
  MOSS_MODEL_ID,
  DEFAULT_WHISPER_MODEL,
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
      tags: ["本地转写", "已完成"],
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
    }).tags).toEqual(["本地转写", "失败"]);

    expect(localRecordToWorkspaceItem({
      ...localRecord,
      status: "transcribing",
      progressPhase: "transcribing",
    }).tags).toEqual(["本地转写", "转写中"]);
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

  it("normalizes whisper and moss configs", () => {
    expect(migrateSttProviderConfig({ provider: "whisper" })).toEqual({
      provider: "whisper",
      model: DEFAULT_WHISPER_MODEL,
      campp_diarization: false,
      expected_speakers: null,
      hotword_package_id: null,
    });
    expect(migrateSttProviderConfig({ provider: "moss_transcribe_diarize" })).toEqual({
      provider: "moss_transcribe_diarize",
      hotword_package_id: null,
    });
  });

  it("resolves per-note > language > default > funasr", () => {
    const config: TranscribeConfig = {
      default: { provider: "funasr" },
      per_language: { zh: { provider: "whisper", model: "small-q5_1" } },
    };
    expect(resolveSttProvider(config, null, null).provider).toBe("funasr");
    expect(resolveSttProvider(config, "zh", null).provider).toBe("whisper");
    expect(resolveSttProvider(config, "en", { provider: "moss_transcribe_diarize" }).provider).toBe(
      "moss_transcribe_diarize",
    );
  });

  it("derives the backing model id per engine", () => {
    expect(providerModelId({ provider: "funasr" })).toBe(FUNASR_MODEL_ID);
    expect(providerModelId({ provider: "whisper", model: "medium-q5_0" })).toBe("medium-q5_0");
    expect(providerModelId({ provider: "moss_transcribe_diarize" })).toBe(MOSS_MODEL_ID);
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
