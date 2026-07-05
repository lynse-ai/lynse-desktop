import { describe, expect, it } from "vitest";
import {
  isLocalFileId,
  localRecordToTranscription,
  localRecordToWorkspaceItem,
  mergeCloudAndLocalFiles,
} from "./local-transcription";
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
