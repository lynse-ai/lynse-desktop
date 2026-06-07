"use client";

import { PageHeader } from "../layout/page-header";
import { FolderOpen } from "lucide-react";

export function FilesPage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader>
        <h1 className="text-sm font-semibold">Files</h1>
      </PageHeader>
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
            <FolderOpen className="size-5 text-muted-foreground" />
          </div>
          <h3 className="text-sm font-medium">No files</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Upload files to manage your documents and media
          </p>
        </div>
      </div>
    </div>
  );
}
