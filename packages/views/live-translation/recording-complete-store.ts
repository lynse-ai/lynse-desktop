"use client";

import { create } from "zustand";
import type { CompletedLiveSession } from "./types";

// ───────────────────────────────────────────────────────────────
// Hand-off channel for sessions stopped outside the recording page
// (the in-app float dock, the tray, the island).
//
// The completion dialog (cloud-sync optional) lives on the recording
// page and is normally fed by that page's own stop call. When a stop
// happens elsewhere we park the result here; the float dock then
// navigates to /recording, where the page picks the session up and
// opens the same dialog. Cleared when the dialog closes.
// ───────────────────────────────────────────────────────────────

interface RecordingCompleteState {
  session: CompletedLiveSession | null;
  open: (session: CompletedLiveSession) => void;
  clear: () => void;
}

export const useRecordingCompleteStore = create<RecordingCompleteState>((set) => ({
  session: null,
  open: (session) => set({ session }),
  clear: () => set({ session: null }),
}));
