"use client";

import { PageHeader } from "../layout/page-header";
import { Mic, Plus, Search, Filter } from "lucide-react";
import { Button } from "@lynse/ui/components/ui/button";
import { Input } from "@lynse/ui/components/ui/input";

export function RecordingsPage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader>
        <div className="flex flex-1 items-center gap-3">
          <h1 className="text-sm font-semibold">Recordings</h1>
          <div className="relative max-w-xs flex-1">
            <Search className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground" />
            <Input
              placeholder="Search recordings..."
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
            <Filter className="size-3" />
            Filter
          </Button>
          <Button size="sm" className="h-7 gap-1.5 text-xs">
            <Plus className="size-3" />
            Upload
          </Button>
        </div>
      </PageHeader>

      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
            <Mic className="size-5 text-muted-foreground" />
          </div>
          <h3 className="text-sm font-medium">No recordings yet</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Upload audio or video files to transcribe and manage
          </p>
          <Button size="sm" className="mt-4 h-8 gap-1.5 text-xs">
            <Plus className="size-3" />
            Upload Recording
          </Button>
        </div>
      </div>
    </div>
  );
}
