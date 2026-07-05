# Offline FunASR Transcription Design

## Scope

Phase 1 adds desktop-only offline transcription. It converts a local audio file to transcript text with FunASR and shows the result as a local file in the Lynse workspace.

This phase does not add Tauri, local summaries, cloud summaries from local text, model downloading, account sync, or audio upload.

## Assumptions

- The current Electron desktop app remains the runtime for phase 1.
- FunASR runs through a local Python process. Users install Python dependencies outside the app for now.
- Local records are private to the desktop device.
- Cloud file APIs remain unchanged.

## Architecture

Electron main process owns local capabilities:

- Pick a local audio file.
- Run a Python FunASR helper.
- Persist local file metadata and transcript text under Electron `userData`.
- Expose typed methods through `window.desktopAPI`.

React views consume a small desktop adapter:

- Merge local records into the existing workspace file list.
- Read local transcription when a selected file id is local.
- Keep cloud files and cloud transcription behavior unchanged.

## Data Shape

Local ids use `local:` prefix. This avoids collisions with backend ids and lets hooks branch without extra server fields.

Local record fields:

- `id`
- `title`
- `sourcePath`
- `createdAt`
- `updatedAt`
- `transcriptText`
- `segments`
- `status`
- `engine`

## FunASR Runner

The helper script uses the current official FunASR Python API pattern:

- `from funasr import AutoModel`
- CPU-friendly `iic/SenseVoiceSmall` by default
- `vad_model="fsmn-vad"`
- Optional `spk_model="cam++"` can be added later

The runner prints JSON only. Electron parses stdout and stores normalized text and segment timing.

## UI

Settings exposes an offline transcription switch. Upload dialog uses local transcription when the switch is on and the desktop API exists.

Local files appear in the existing file list with a local tag. Selecting a local file opens the existing transcription tab and renders local transcript text.

## Verification

- Unit tests for local record normalization and cloud/local file merge behavior.
- Electron typecheck for IPC and preload additions.
- Views typecheck for renderer adapter usage.
