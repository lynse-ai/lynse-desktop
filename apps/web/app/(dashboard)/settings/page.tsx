"use client";

import { useRouter } from "next/navigation";
import { SettingsDialog } from "@lynse/views/settings";

export default function Page() {
  const router = useRouter();
  // Settings is shown in a popup dialog instead of an inline page. Closing the
  // dialog navigates back to the workspace root.
  return <SettingsDialog open onOpenChange={() => router.push("/")} />;
}
