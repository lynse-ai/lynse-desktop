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
  /** Record id of the most recent save (dialog "保存" or an auto-save from
   *  the remembered "记住选择" choice). Drives the recording page's header
   *  workbench button. Deliberately survives `clear()` — the button should
   *  stay visible after the dialog closes. */
  savedRecordId: string | null;
  open: (session: CompletedLiveSession) => void;
  markSaved: (recordId: string) => void;
  clear: () => void;
}

export const useRecordingCompleteStore = create<RecordingCompleteState>((set) => ({
  session: null,
  savedRecordId: null,
  open: (session) => set({ session }),
  markSaved: (savedRecordId) => set({ savedRecordId }),
  clear: () => set({ session: null }),
}));
