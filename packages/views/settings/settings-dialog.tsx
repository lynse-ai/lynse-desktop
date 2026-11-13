"use client";

import { lazy, Suspense, useState } from "react";

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSectionId?: string;
}

const Content = lazy(() =>
  import("./settings-dialog-content").then(({ SettingsDialogContent }) => ({ default: SettingsDialogContent })),
);

export function SettingsDialog(props: SettingsDialogProps) {
  const [opened, setOpened] = useState(props.open);
  if (props.open && !opened) setOpened(true);
  if (!props.open && !opened) return null;
  return <Suspense><Content {...props} /></Suspense>;
}
