"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { FileText, Eye, Columns2 } from "../../icons";
import { MilkdownEditor, setMarkdown, getHTML } from "./milkdown-editor";
import { FloatingMarkdownToolbar } from "./markdown-toolbar";
import { useWorkspaceStore } from "../store";
import { useFileOutline, useFileConclusions } from "../hooks/use-files";
import { useTranslation } from "@lynse/core/i18n/react";
import type { Editor } from "@milkdown/kit/core";
import type { EditorMode } from "../types";

export function EditorPanel() {
  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const editorMode = useWorkspaceStore((s) => s.editorMode);
  const setEditorMode = useWorkspaceStore((s) => s.setEditorMode);
  const { t } = useTranslation();

  const [editor, setEditor] = useState<Editor | null>(null);

  const MODE_TABS: { mode: EditorMode; icon: typeof FileText; label: string }[] = [
    { mode: "edit", icon: FileText, label: t("workspace.edit") },
    { mode: "preview", icon: Eye, label: t("workspace.preview") },
    { mode: "split", icon: Columns2, label: t("workspace.split") },
  ];

  const { data: outline } = useFileOutline(selectedItemId);
  const { data: conclusions } = useFileConclusions(selectedItemId);

  const content = useMemo(() => {
    const parts: string[] = [];
    if (outline?.content) parts.push(outline.content);
    if (conclusions?.length) {
      parts.push(
        ...conclusions.map((c) => String(c.content ?? c.conclusionText ?? "")).filter(Boolean),
      );
    }
    return parts.join("\n\n") || "# Select a file to view its content";
  }, [outline, conclusions]);

  const [previewHtml, setPreviewHtml] = useState("");

  useEffect(() => {
    if (selectedItemId) {
      setMarkdown(content);
    }
  }, [selectedItemId, content]);

  const handleEditorChange = useCallback(() => {
    if (editorMode === "split" || editorMode === "preview") {
      setPreviewHtml(getHTML());
    }
  }, [editorMode]);

  const handleEditorReady = useCallback((inst: Editor | null) => {
    setEditor(inst);
  }, []);

  if (!selectedItemId) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
          <FileText className="size-5 text-muted-foreground" />
        </div>
        <h3 className="text-sm font-medium">{t("workspace.no_file_selected")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("workspace.select_file_hint")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        {MODE_TABS.map(({ mode, icon: Icon, label }) => (
          <button
            key={mode}
            onClick={() => setEditorMode(mode)}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs ${
              editorMode === mode
                ? "bg-muted font-medium"
                : "text-muted-foreground hover:bg-muted/50"
            }`}
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-hidden">
        {editorMode === "edit" && (
          <>
            <MilkdownEditor onChange={handleEditorChange} onEditorReady={handleEditorReady} />
            <FloatingMarkdownToolbar editor={editor} />
          </>
        )}
        {editorMode === "preview" && (
          <div
            className="prose prose-sm max-w-none overflow-auto px-6 py-4 h-full"
            dangerouslySetInnerHTML={{ __html: previewHtml || getHTML() }}
          />
        )}
        {editorMode === "split" && (
          <div className="flex h-full">
            <div className="flex-1 overflow-auto border-r">
              <MilkdownEditor onChange={handleEditorChange} onEditorReady={handleEditorReady} />
              <FloatingMarkdownToolbar editor={editor} />
            </div>
            <div
              className="flex-1 overflow-auto"
              dangerouslySetInnerHTML={{ __html: previewHtml || getHTML() }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
