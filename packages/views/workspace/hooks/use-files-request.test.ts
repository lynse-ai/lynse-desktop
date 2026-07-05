import { describe, expect, it } from "vitest";
import { buildFilesRequest } from "./use-files";

describe("buildFilesRequest", () => {
  it("uses the general file page endpoint for all files", () => {
    expect(buildFilesRequest({ pageNum: 2, pageSize: 50, folderId: "__all__" })).toEqual({
      path: "/api/business/file/page",
      params: {
        pageNum: 2,
        pageSize: 50,
        originalFilename: undefined,
      },
      includeLocalRecords: true,
    });
  });

  it("uses the general file page endpoint for a selected backend folder", () => {
    expect(buildFilesRequest({ pageNum: 1, pageSize: 200, folderId: "folder-1" })).toEqual({
      path: "/api/business/file/page",
      params: {
        pageNum: 1,
        pageSize: 200,
        originalFilename: undefined,
      },
      includeLocalRecords: true,
    });
  });

  it("keeps local records out of trash", () => {
    expect(buildFilesRequest({ folderId: "__trash__" }).includeLocalRecords).toBe(false);
  });
});
