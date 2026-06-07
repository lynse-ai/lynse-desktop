"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { FileText, Eye, Columns2 } from "lucide-react";
import { MilkdownEditor, setMarkdown, getHTML } from "./milkdown-editor";
import { useWorkspaceStore } from "../store";
import { useFileOutline, useFileConclusions } from "../hooks/use-files";
import type { EditorMode } from "../types";

const MODE_TABS: { mode: EditorMode; icon: typeof FileText; label: string }[] = [
  { mode: "edit", icon: FileText, label: "Edit" },
  { mode: "preview", icon: Eye, label: "Preview" },
  { mode: "split", icon: Columns2, label: "Split" },
];

export function EditorPanel() {
  const selectedItemId = useWorkspaceStore((s) => s.selectedItemId);
  const editorMode = useWorkspaceStore((s) => s.editorMode);
  const setEditorMode = useWorkspaceStore((s) => s.setEditorMode);

  const { data: outline } = useFileOutline(selectedItemId);
  const { data: conclusions } = useFileConclusions(selectedItemId);

  const content = useMemo(() => {
    const parts: string[] = [];
    if (outline?.content) parts.push(outline.content);
    if (conclusions?.length) {
      parts.push(
        ...conclusions.map((c) => c.content).filter(Boolean),
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

  if (!selectedItemId) {
    return (
      <div className="flex h-full flex-col items-center justify-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
          <FileText className="size-5 text-muted-foreground" />
        </div>
        <h3 className="text-sm font-medium">No file selected</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Select a file from the directory to view and edit
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
          <MilkdownEditor onChange={handleEditorChange} />
        )}
        {editorMode === "preview" && (
          <div
            className="prose prose-sm max-w-none px-6 py-4"
            dangerouslySetInnerHTML={{ __html: previewHtml || getHTML() }}
          />
        )}
        {editorMode === "split" && (
          <div className="flex h-full">
            <div className="flex-1 overflow-auto border-r">
              <MilkdownEditor onChange={handleEditorChange} />
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
