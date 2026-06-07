"use client";

import { PageHeader } from "../layout/page-header";
import { Calendar, Plus } from "lucide-react";
import { Button } from "@lynse/ui/components/ui/button";

export function MeetingsPage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader>
        <div className="flex flex-1 items-center gap-3">
          <h1 className="text-sm font-semibold">Meetings</h1>
        </div>
        <Button size="sm" className="h-7 gap-1.5 text-xs">
          <Plus className="size-3" />
          New Meeting
        </Button>
      </PageHeader>

      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
            <Calendar className="size-5 text-muted-foreground" />
          </div>
          <h3 className="text-sm font-medium">No meetings</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Create meetings to organize your recordings and notes
          </p>
        </div>
      </div>
    </div>
  );
}
