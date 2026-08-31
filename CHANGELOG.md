# Changelog

## 0.1.28 (2026-08-31)

### Fixed
- Restore the AI-assistant (chat) icon unread badge. In 0.1.27 chat unread was folded into the Bell only, forcing an extra step to learn the assistant had replied; the chat icon now shows the total unseen reply count again, while the Bell stays the unified notification center.

### Changed
- Version-update availability now also appears as an entry in the notification center (Bell drawer): an available update shows as a "New version available" item that opens the release page in your browser. The avatar upgrade-arrow cue is retained.

## 0.1.27 (2026-08-31)

### New Features

- Unified notification center: the Bell icon now shows an unread count badge (capped 99+) and opens a notification drawer with a scrollable list, "mark all as read", and deep links back to the source (recording / chat). Chat unread replies are aggregated into this center instead of a separate chat badge.
- Recording & transcription events (upload complete, saved locally) now persist as reviewable notifications instead of a toast that vanishes after a few seconds.
- Cloud-backed Todo list: todos now sync with lynse.ai (list / update / delete / clear-completed) and fall back to local storage when signed out.
- Maximized-window UX: double-click the title bar to maximize / restore; on very wide windows the reading column stays centered instead of stretching edge-to-edge.

### Changed

- Rename the main 68px sidebar component `TencentMeetingSidebar` → `LynseSidebar` (it was never Tencent-meeting-specific).
- Recording-page empty state redesigned: lighter import / record cards with semantic icons and a calm animated waveform backdrop.
- i18n: add a scripted audit (`pnpm i18n:check`); settings modules (STT config, settings dialog) fully localized; fixed several bare i18n keys; replaced dark-mode-only hover backgrounds (`bg-white/[0.06]`) with theme-aware `hover:bg-accent` across the sidebar, file list, and user menu.
- CI: harden `fetch-sidecars.sh` for bash 3.2 on macOS (unblocks the release build).

## 0.1.26 (2026-08-31)

### New Features

- Add VibeVoice-ASR-BitNet (Microsoft, MIT) as a new local offline STT engine — a pure-CPU ggml engine supporting 7 languages (zh/en/fr/it/ko/pt/vi). It appears as "VibeVoice-ASR-BitNet（本地·CPU）" in the STT engine dropdown and downloads its two GGUF weights on first use.
- Notes list is now grouped by time — 今天 / 昨天 / 本周 / 本月 / 上个月, then by month — so recent recordings and notes are easy to scan.
- Add an "About" entry to the avatar dropdown that shows the current version at a glance; when a newer release is available, an upgrade-arrow badge appears on the avatar itself.
- Integrate the Qoder Cloud Agent chat (cloud-hosted agent backend) alongside recording-first local capture, plus a native macOS menu bar, tray, and live waveform.

### Changed

- Remove the MOSS-Transcribe-Diarize offline engine: its hosted model weights (the `moss-transcribe-diarize-0.9b-q5_0.gguf` download URL) are no longer available, so the engine could not be installed. VibeVoice replaces it in the engine list and in the shared STT runtime (the `moss-transcribe` sidecar is replaced by `vibeasr`).
- Notes list now shows ALL files on first entry (previously it only showed uncategorized files).
- Notes list caches the last successful listing locally, eliminating the blank flash when you click refresh.
- Fix: the notes time-section header sometimes rendered the raw i18n key (`notes.time_thisMonth`) instead of a readable label.

## 0.1.25 (2026-08-19)

## 0.1.25 (2026-08-19)

### New Features

- Add date, recording duration, and recording type tags to the Notes list, including 会议录音 and 通话录音 labels.
- Add a draggable divider between the note list and note content, with keyboard controls and persisted width.

### Changed

- Improve the Notes layout, startup window sizing, and metadata readability across desktop resolutions.

## 0.1.24 (2026-08-19)

### New Features

- Rename "记忆" (Memory) to "笔记" (Notes) across the sidebar, the zh/en/ja locales, and routing. The Notes page is the home for your meeting recordings and the notes attached to them.

### Changed

- Reconnect the Notes page to the correct backend listing. It now calls `GET /api/business/file/timeRange/list` (the same endpoint `lynse meetings list` uses) instead of the generic all-files endpoint, so it shows your recordings and notes rather than every uploaded file. The "Recordings" tab also matches cloud audio/video files by MIME type, not just local transcriptions.
- Overhaul the live-translation transcript detail page and refine the floating dynamic-island and recording-complete dialog; remove the now-unused realtime-session completion call.
- Refine the workspace file list, sidebar, and dashboard layout, plus small tweaks to the settings dialog and web settings page.
- Remove the Feishu (飞书) account authorization feature — its OAuth flow, settings card, and the related Rust/permission wiring are gone.
- Repo hygiene: ignore local Python virtualenvs, Playwright CLI state, and AI-tooling state; stop tracking those accidentally-committed artifacts.

## 0.1.23 (2026-08-12)

### New Features

- Add Volcengine AST v4 as a real-time transcription provider, with credentials stored in the operating system keychain and results normalized into the existing live-segment pipeline.
- Unify recording and live transcription in one session page with pure recording, live transcription, and simultaneous translation modes, plus a real-time waveform and a completion dialog for saving the result.

### Changed

- Redesign the shared dark interface around an Apple-inspired graphite palette with one restrained indigo accent, removing cyan/teal controls, decorative colour glows, and idle waveform motion while improving text and border contrast.
- Improve todo refresh and clear-completed feedback with visible progress states and automatic reconciliation with local storage.
- Refine the sidebar, live-translation controls, workspace empty states, recording actions, and AI assistant surfaces for a clearer visual hierarchy.

## 0.1.22 (2026-07-31)

### New Features

- Add switchable AI assistant IP avatars: five transparent-background GIF personas (Default / Star Hat / Top Hat / Bow / Beret) are bundled with the app; click the assistant avatar in the chat header, empty state, or chat page to cycle through them, and the new persona animates in from small to large on each switch.
- Add an AI assistant confirmation dialog (a2UI-style): when the assistant reply needs user confirmation, a clickable dialog pops up instead of requiring you to type "A/B/C". It supports the backend a2UI `type:"confirm"` protocol event directly, and also auto-detects a sequential option list (`A)` / `B)` / `C)` or `1.` / `2.` / `3.`) in the assistant's finished text to trigger the dialog; clicking an option sends it as the next message, while cancel closes the dialog without sending.

### Changed

- Move the AI Assistant entry in the sidebar from the bottom Tools section to directly under Live Translation (always visible).
- Shrink the AI assistant avatar inside chat messages and align it to the first text line so it no longer dominates the message row.

### Bug Fixes

- Remove the duplicate AI Assistant navigation entry that previously appeared both in the bottom Tools section and the workspace nav.

## 0.1.21 (2026-07-31)

### New Features

- Add a local offline transcription engine powered by Apple MLX (MLX-Whisper) on macOS with Apple Silicon. It appears as a new option in the STT engine dropdown alongside FunASR / Whisper / MOSS, runs fully on-device for faster and more power-efficient transcription, downloads its model weights on first use, and decodes audio with a bundled ffmpeg so it needs no shared STT runtime. On non-Apple-Silicon platforms it shows a clear prompt to switch back to FunASR / Whisper.
- Add Alibaba Cloud Qwen (DashScope `qwen3.5-livetranslate-flash-realtime`) as a selectable real-time translation engine, joining the existing iLiveData backend and iLiveData direct options.

### Changed

- Real-time translation engine is now user-selectable (lynse_backend / ilivedata_direct / qwen) from a dropdown; real-time translation remains cloud-only and does not use local/offline MLX inference.

### Bug Fixes

- Fix macOS "Load failed" when connecting to a plaintext `http://` backend: inject `NSAppTransportSecurity` / `NSAllowsArbitraryLoads` into the bundled `Info.plist` so the WKWebView is allowed to reach HTTP test servers (App Transport Security was silently blocking non-localhost plaintext requests).
- Change the default API base URL from the `http://119.97.160.133:10060` test server to the official HTTPS endpoint `https://api.lynse.cn` across the desktop settings dialog, settings page, and web proxy route.
- Fix AI chat markdown table rendering: the first column was pinned to 40 px (`first:w-10`) and cells were force-truncated, causing dates to collapse into "2...", headers to overflow and visually merge (e.g. "截止时间负责人"), and owner cells to disappear. Switched minimal-mode tables to auto-layout with `min-w-[100px]` per cell, `break-words` wrapping, and visible row/column borders.

## 0.1.20 (2026-07-28)

### New Features

- Add one-click Feishu (飞书) account authorization in the desktop settings page: opens the system browser for OAuth with PKCE and random state validation; the short-term user access token is stored in the OS Keychain and account display info is saved in the app data directory, with re-authorize and disconnect options
- Add live-translation quick controls to the system tray menu: start or pause real-time recording directly from the tray without opening the main window
- Improve the macOS system-audio permission flow: requesting system-audio permission now opens System Settings directly to the Screen & System Audio Recording section, and the audio-capture helper pre-checks microphone and screen-capture permissions before starting with clear Chinese error messages

### Changed

- Permission status now includes a `system_audio_required` field; the live-translation start button checks both microphone and system-audio permissions before enabling
- The Swift audio-capture helper now uses the return value of `CGRequestScreenCaptureAccess()` to determine whether a restart is needed, instead of always returning `restartRequired = true`

### Bug Fixes

- Fix the macOS audio-capture helper always reporting `restartRequired = true` regardless of whether screen-capture permission was actually granted

## 0.1.19 (2026-07-23)

### New Features

- Redesign the live-translation floating subtitle window with an Apple-style Liquid Glass look: translucent frosted-glass card with gradient fill, backdrop blur + saturation, thin specular rim highlight, and high-contrast dark text
- Add minimize-to-status-bar for the floating subtitle window: a hover-revealed button hides the window, and a new system tray icon (menu: 显示主窗口 / 显示实时字幕 / 退出) can bring it back

## 0.1.18 (2026-07-23)

### Bug Fixes

- Fix live translation rendering the same spoken sentence as multiple duplicated dialog bubbles: each utterance now maps to a single segment, and the recognizer's rolling-buffer corrections (which are not always strict prefixes) refresh that bubble in place instead of spawning a new card

## 0.1.17 (2026-07-23)

### New Features

- Add real-time translation support on Windows (stage 1): capture the default microphone with cpal, resample to 16 kHz mono 16-bit PCM, and feed the existing cloud STT + translation + subtitle pipeline; system-audio loopback capture is planned for a later stage

### Changed

- Enable the real live_translation module on Windows (previously a stub); isolate macOS-only Unix-socket, Swift sidecar, and process-signal code behind `cfg(target_os = "macos")`

## 0.1.16 (2026-07-22)

### New Features

- Show the software-update reminder under the username and membership in the sidebar, checked automatically on app launch

### Changed

- Live translation real-time view shows the source text on top and the translation below, segmented by semantics; the backend now merges rolling-buffer updates into a single in-place refreshing segment instead of appending duplicate segments

### Bug Fixes

- Shrink the desktop installer to ~6.4 MB by downloading the STT runtime on demand
- Fix Windows CI packaging so the Windows msi is produced (it was missing due to an MSYS tar path bug)

## 0.1.13 (2026-07-22)

### New Features

- Add real-time bilingual transcription and translation on macOS with separate microphone and system-audio streams, floating subtitles, pause/resume, and local recovery
- Add switchable live-translation providers, including test-only iLiveData direct client authentication with credentials stored in the operating system keychain

### Changed

- Require macOS 15 for dual-stream capture and bundle the native audio-capture helper in the desktop installer
- Preserve API keys after failed connection attempts and display source and translated text in local transcription details
- Improve Markdown table sizing and truncation

### Bug Fixes

- Hide internal meeting identifiers from assistant replies while preserving Markdown links
- Bundle the MOSS transcription engine and Windows FFmpeg as self-contained binaries, and validate sidecars before publishing installers
- Keep the macOS-only audio-capture helper from breaking Windows packaging

## 0.1.11 (2026-07-19)

### New Features

- Multi-engine local transcription: choose between FunASR, Whisper, and MOSS-Transcribe-Diarize as the local STT engine, with per-engine settings (Whisper model, CAM++ diarization, expected speaker count, hotwords)
- STT routing UI in Settings with an engine picker and engine-specific configuration, localized in English, Japanese, and Chinese
- Bundle STT engine and media binaries (whisper, moss-transcribe, ffmpeg, ffprobe) as Tauri sidecar resources

### Changed

- CI fetches/builds the STT sidecars and smoke-tests whisper, moss-transcribe, and ffmpeg on both Windows and macOS before bundling
- Refactor the local transcription adapter to route by STT provider and resolve per-model status
- Auto-migrate legacy FunASR transcription configs to the new provider-tagged format; normalize Whisper and MOSS configs with sensible defaults

## 0.1.6 (2026-07-13)

### New Features

- Local todos in the desktop app, with the option to add a todo to the macOS system Calendar

### Changed

- Simplify web app state and remove obsolete code paths
- Redesign the desktop sidebar header with the Lynse wordmark and a draggable region for the frameless window

### Bug Fixes

- Fix TypeScript errors that broke `pnpm typecheck` (i18next selector form did not resolve across packages; correct a test helper call)

## 0.1.5 (2026-07-06)

### Changed

- Refine voiceprint settings and the enrollment flow
- Simplify web app routing and remove obsolete code

## 0.1.4 (2026-06-21)

### New Features

- Upload dialog for adding new recordings to the workspace
- Template manager and template selector with search, filtering, and selection
- Resummarize dialog to regenerate summaries with a chosen template and processing feedback
- SSE streaming support in the API client with abort control and chunk parsing

### Changed

- Add API proxy in the Electron Vite config for reliable streaming and request body forwarding
- Extend localization with upload, template, and resummarize texts in English, Japanese, and Chinese
- Adapt content-preview styles for desktop and override mobile-fixed widths
- Add RefreshCw and Square icons for the new UI actions
- Add a resummarize button to the content panel toolbar

## 0.1.3 (2026-06-17)

### New Features

- Floating Markdown toolbar with formatting, heading, list, blockquote, image, and undo actions integrated with the Milkdown editor
- Draggable desktop title bar with folder/file breadcrumb and outline, source, and chat panel toggles
- Source view mode to inspect raw HTML or Markdown for outlines and summaries
- User membership tier display in sidebar with localized plan names
- Detailed minutes and credits usage popover in user profile dropdown
- API hook to fetch membership quota and details

### Changed

- Move file list search query and sort state (field + direction) into the workspace store for persistence
- Relocate chat panel, outline sidebar, and source view toggles from the content panel into the title bar
- Polish Markdown toolbar interactions and summary editor layout
- Conditionally open desktop DevTools based on a debug environment variable

## 0.1.2 (2026-06-12)

### New Features

- Editable Markdown editor for meeting summaries with auto-save
- Dynamic tab system: one tab per summary with template names, "+" to add notes
- Floating shadow system for overlays (dialog, popover, dropdown, select)
- 4-level stroke hierarchy (primary → quaternary) for consistent border strength
- Brand-derived accent fills via color-mix for tab active/hover states
- Authenticated image loading (blob URL proxy) for mind maps in summaries

### Bug Fixes

- Fix API error field handling (msg vs message) for correct error reporting
- Fix user info endpoint to use /current instead of /detail
- Tokenize speaker colors from hardcoded hex to oklch with dark mode support

### Changed

- Extract layout constants (tab bar height, page inset) for consistent spacing
- Remove debug logging from content panel
- Upgrade overlay components from ring-based to shadow-based elevation

## 0.1.1 (2026-06-12)

### New Features

- Add settings dialog with theme switching and API configuration
- Add drag-and-drop file moving in workspace
- Add user credits display in workspace UI

## 0.1.0 (2026-06-11)

### New Features

- Initial Lynse webapp monorepo with Next.js, Electron, and shared packages
- App sidebar with navigation sections and workspace management
- i18n support with English, Chinese, and Japanese locales
- Workspace content panel with folder and file management
- Audio player component for workspace recordings
- Workspace hooks for folder counts, mutations, and file operations
- Shared tsconfig for React libraries
- Desktop app with electron-vite configuration

### Changed

- Improved workspace store with expanded state management
- Updated settings, recordings, meetings, and knowledge-base pages
- Enhanced desktop app styling and configuration
