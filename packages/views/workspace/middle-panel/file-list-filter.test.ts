import { describe, expect, it } from "vitest";
import type { WorkspaceItem } from "../types";
import { filterWorkspaceFilesByFolder } from "./file-list-filter";

const files: WorkspaceItem[] = [
  {
    id: "file-product",
    type: "file",
    title: "产品会议",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    folderId: "folder-product",
  },
  {
    id: "file-sales",
    type: "file",
    title: "商务销售会议",
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    folderId: "folder-sales",
  },
  {
    id: "file-empty",
    type: "file",
    title: "未分组会议",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
  },
  {
    id: "local:offline",
    type: "file",
    title: "本地录音.wav",
    createdAt: "2026-07-04T00:00:00.000Z",
    updatedAt: "2026-07-04T00:00:00.000Z",
  },
];

describe("filterWorkspaceFilesByFolder", () => {
  it("keeps only files in the selected backend folder", () => {
    expect(filterWorkspaceFilesByFolder(files, "folder-product").map((file) => file.id)).toEqual([
      "file-product",
    ]);
  });

  it("keeps local transcription files in their own virtual folder", () => {
    expect(filterWorkspaceFilesByFolder(files, "__local_transcriptions__").map((file) => file.id)).toEqual([
      "local:offline",
    ]);
  });

  it("does not treat local transcription files as uncategorized cloud files", () => {
    expect(filterWorkspaceFilesByFolder(files, "__uncategorized__").map((file) => file.id)).toEqual([
      "file-empty",
    ]);
  });
});
