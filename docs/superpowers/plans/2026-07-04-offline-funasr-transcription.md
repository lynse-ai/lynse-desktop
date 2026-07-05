# Offline FunASR Transcription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add desktop-only local audio transcription with FunASR and show local transcript records in the workspace.

**Architecture:** Electron main process runs and stores local transcription records. Shared React views call a desktop adapter and keep existing cloud API behavior unchanged.

**Tech Stack:** Electron IPC, React Query, TypeScript, Python FunASR helper.

---

### Task 1: Local Transcription Types and Renderer Adapter

**Files:**
- Create: `packages/views/workspace/local-transcription.ts`
- Modify: `packages/views/workspace/types.ts`
- Test: `packages/views/workspace/local-transcription.test.ts`

- [x] Define local record, transcript segment, and desktop API types.
- [x] Add helpers to detect local ids and normalize local records into `WorkspaceItem` and transcription data.
- [x] Verify with unit tests.

### Task 2: Electron Main Process Local Store and FunASR Runner

**Files:**
- Create: `apps/desktop/src/main/local-transcription.ts`
- Create: `apps/desktop/resources/funasr_transcribe.py`
- Modify: `apps/desktop/src/main/index.ts`

- [x] Store local records in `app.getPath("userData")/local-transcriptions/index.json`.
- [x] Spawn Python helper for selected audio files.
- [x] Register IPC handlers for pick, transcribe, list, and get.

### Task 3: Preload API

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/preload/index.d.ts`

- [x] Expose `desktopAPI.localTranscription`.
- [x] Keep existing `openExternal` and `appInfo` behavior unchanged.

### Task 4: Workspace Hooks and Upload Flow

**Files:**
- Modify: `packages/views/workspace/hooks/use-files.ts`
- Modify: `packages/views/workspace/upload-dialog.tsx`
- Modify: `packages/views/workspace/middle-panel/file-list.tsx`

- [x] Merge local records into file list.
- [x] Return local transcript data for local ids.
- [x] Let upload dialog run local transcription when offline mode is enabled.

### Task 5: Settings and Locale Text

**Files:**
- Modify: `packages/views/settings/settings-dialog.tsx`
- Modify: `packages/views/locales/en.ts`
- Modify: `packages/views/locales/zh.ts`
- Modify: `packages/views/locales/ja.ts`

- [x] Add offline transcription switch.
- [x] Persist switch in `localStorage`.

### Task 6: Verification

**Commands:**
- `pnpm --filter @lynse/views test`
- `pnpm --filter @lynse/views typecheck`
- `pnpm --filter @lynse/desktop typecheck`
