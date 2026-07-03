import { describe, expect, it, vi } from "vitest";
import {
  createInfographicSummaryHtml,
  mergePendingSummaryTab,
  parseFileTags,
  replaceSummaryTemplate,
  waitForAiTaskResult,
  waitForTranscriptionCompletion,
} from "./use-files";

describe("summary task polling", () => {
  it("polls transcription status until the file reaches a terminal state", async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ file_1: { status: "processing" } })
      .mockResolvedValueOnce({ file_1: { status: "COMPLETED" } });

    const result = await waitForTranscriptionCompletion({
      fileIds: ["file_1"],
      getStatus,
      sleep: async () => {},
    });

    expect(result.file_1?.status).toBe("COMPLETED");
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("polls an AI conclusion task until the generated conclusion is available", async () => {
    const getResult = vi
      .fn()
      .mockResolvedValueOnce({ status: "running", taskId: "task_1" })
      .mockResolvedValueOnce({
        status: "COMPLETED",
        taskId: "task_1",
        conclusion: {
          id: "conclusion_1",
          fileId: "file_1",
          conclusionText: "done",
          generateSuccess: true,
        },
      });

    const result = await waitForAiTaskResult({
      fileId: "file_1",
      taskId: "task_1",
      aiTaskType: "CONCLUSION",
      getResult,
      sleep: async () => {},
    });

    expect(result.conclusion?.conclusionText).toBe("done");
    expect(getResult).toHaveBeenCalledWith({
      fileId: "file_1",
      taskId: "task_1",
      aiTaskType: "CONCLUSION",
    });
    expect(getResult).toHaveBeenCalledTimes(2);
  });

  it("replaces a summary by generating the new one before deleting the old one", async () => {
    const startAiTask = vi.fn().mockResolvedValue("task_1");
    const waitForResult = vi.fn().mockResolvedValue({
      status: "COMPLETED",
      taskId: "task_1",
      conclusion: {
        id: "new_conclusion",
        fileId: "file_1",
        conclusionText: "new summary",
        generateSuccess: true,
      },
    });
    const deleteConclusion = vi.fn().mockResolvedValue(undefined);

    const result = await replaceSummaryTemplate({
      fileId: "file_1",
      oldConclusionId: "old_conclusion",
      templateId: "template_1",
      startAiTask,
      waitForResult,
      deleteConclusion,
    });

    expect(result.conclusion?.id).toBe("new_conclusion");
    expect(startAiTask).toHaveBeenCalledWith({
      aiTaskType: "CONCLUSION",
      fileId: "file_1",
      templateId: "template_1",
    });
    expect(deleteConclusion).toHaveBeenCalledWith("old_conclusion");
    const waitCallOrder = waitForResult.mock.invocationCallOrder[0];
    const deleteCallOrder = deleteConclusion.mock.invocationCallOrder[0];
    expect(waitCallOrder).toBeDefined();
    expect(deleteCallOrder).toBeDefined();
    expect(waitCallOrder!).toBeLessThan(deleteCallOrder!);
  });

  it("replaces a pending summary tab with the generated conclusion", () => {
    const tabs = mergePendingSummaryTab({
      tabs: [
        { key: "existing-0", id: "old", name: "旧总结", text: "old", status: "ready" },
        { key: "pending-1", id: "", name: "项目汇报", text: "", status: "pending", pendingId: "pending-1" },
      ],
      pendingId: "pending-1",
      conclusion: {
        id: "new",
        fileId: "file_1",
        conclusionText: "new content",
        templateName: "项目汇报",
        createdAt: "now",
      },
    });

    expect(tabs).toEqual([
      { key: "existing-0", id: "old", name: "旧总结", text: "old", status: "ready" },
      { key: "new", id: "new", name: "项目汇报", text: "new content", status: "ready" },
    ]);
  });

  it("parses tags from common file list fields", () => {
    expect(parseFileTags({ tags: "销售, 复盘 项目" })).toEqual(["销售", "复盘", "项目"]);
    expect(parseFileTags({ tagList: ["会议", "客户"] })).toEqual(["会议", "客户"]);
    expect(parseFileTags({ categoryName: "访谈" })).toEqual(["访谈"]);
    expect(parseFileTags({ folderName: "项目会议" })).toEqual(["项目会议"]);
  });

  it("creates marked infographic summary html from generated text", () => {
    const html = createInfographicSummaryHtml({
      title: "AI硬件与数字版权创新",
      source: "核心结论\n- 产品方向：覆盖动态展示场景\n- 技术实现：AI生成内容\n- 商业模式：版权运营",
    });

    expect(html).toContain('data-summary-template="infographic"');
    expect(html).toContain("AI硬件与数字版权创新");
    expect(html).toContain("核心发展脉络");
    expect(html).toContain("产品方向");
    expect(html).toContain("技术实现");
  });
});
