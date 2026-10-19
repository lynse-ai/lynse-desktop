"use client";

import { create } from "zustand";
import type { DesktopWorkbenchApi, WorkbenchStatus, SourceRef } from "./types";

export function getWorkbenchApi(): DesktopWorkbenchApi | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { desktopAPI?: { workbench?: DesktopWorkbenchApi } }).desktopAPI?.workbench ?? null;
}

interface WorkbenchUI {
  status: WorkbenchStatus | null;
  error: string | null;
  open: boolean;
  query: string;
  selectedId: string | null;
  selectedSource: SourceRef | null;
  setStatus(status: WorkbenchStatus | null): void;
  setError(error: string | null): void;
  show(query?: string, id?: string): void;
  close(): void;
  select(id: string): void;
  showSource(source: SourceRef): void;
}
export const useWorkbench = create<WorkbenchUI>((set) => ({
  status: null, error: null, open: false, query: "", selectedId: null, selectedSource: null,
  setStatus: (status) => set({ status, error: null }),
  setError: (error) => set({ error }),
  show: (query = "", id) => set({ open: true, query, selectedId: id ?? null, selectedSource: null }),
  close: () => set({ open: false, selectedId: null, selectedSource: null }),
  select: (selectedId) => set({ selectedId, selectedSource: null }),
  showSource: (source) => set({ open: true, selectedId: source.id, selectedSource: source }),
}));

export async function refreshWorkbench(): Promise<void> {
  const bridge = getWorkbenchApi();
  if (!bridge) return;
  try { useWorkbench.getState().setStatus(await bridge.status()); }
  catch (error) { useWorkbench.getState().setError(String(error)); }
}
