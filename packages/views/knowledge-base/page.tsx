"use client";

import { PageHeader } from "../layout/page-header";
import { BookOpen, Plus } from "lucide-react";
import { Button } from "@lynse/ui/components/ui/button";

export function KnowledgeBasePage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader>
        <div className="flex flex-1 items-center gap-3">
          <h1 className="text-sm font-semibold">Knowledge Base</h1>
        </div>
        <Button size="sm" className="h-7 gap-1.5 text-xs">
          <Plus className="size-3" />
          New Note
        </Button>
      </PageHeader>

      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
            <BookOpen className="size-5 text-muted-foreground" />
          </div>
          <h3 className="text-sm font-medium">Knowledge base is empty</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Create notes and documents with the Markdown editor
          </p>
        </div>
      </div>
    </div>
  );
}
