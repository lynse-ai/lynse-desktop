# Changelog

> The 1.0.0 – 1.0.4 entries below were backfilled on 2026-09-20 from tag and
> release history — those four releases shipped without CHANGELOG entries. The
> v1.0.3 release commit squashed ~113 files into a single commit, so its entry
> is coarser than the ones around it. 1.0.0 shipped as the commit
> `release: v1.0.0(1)` and was never tagged; 1.0.1 and 1.0.2 appear nowhere in
> the history (that commit documents a `vA.B.C(N)` build-counter tag
> convention), so they are not listed either.

## 1.1.1 (2026-09-27)

### New Features

- 聊天回复支持附件：图片卡片（全屏查看、下载、转发）与 PDF 文件卡片。过期的下载链接会在打开前重新签名，不再出现点开后链接已失效的情况。
- AI 助手可以配置独立的后端地址，常规业务请求不受影响。

### Performance

- 流式回答不会再闪出半个 emoji 或把英文单词截断——打字机切片现在对齐到字符与单词边界。
- 流式输出时活跃会话的状态写入合并为一次更新，每帧的渲染开销明显下降。

### Fixed

- 录音保存到云不再依赖云存储桶对桌面端跨域（CORS）的放行配置：音频由应用原生层签名后直传，失败时日志会记录上传地址与云端返回的具体内容。
- 上传失败现在会指明是三步中的哪一步（创建占位 / 获取上传凭证 / 通知上传完成）以及服务端返回码，不再只显示一句「系统繁忙」。
- 在笔记列表里删除本地录音后，该行不再残留在列表中；删除失败也会显示原因，而不是看起来毫无反应。
- 删除本地录音会一并清理它在磁盘上的音频目录，不再留下孤立的 WAV 文件。

### Changed

- 侧边栏收窄，macOS 红绿灯间距与位置随之调整；首页隐藏滚动条。

## 1.1.0 (2026-09-23)

### New Features

- Recordings can now be saved straight to the cloud. Choosing 保存到云 uploads the finished recording directly to cloud storage — the app fetches short-lived STS credentials and pushes the audio itself, so the bytes never detour through the API server — then kicks off server-side transcription and summarization as usual. The recording's start time travels with the upload, so the cloud file list sorts by when the meeting actually happened.
- A failed cloud upload no longer strands a recording locally forever. The note's detail panel gains an 上传到云 action that re-runs the upload against the same cloud record — retrying never duplicates the file, and a successful retry cleans up the local cache as usual.

### Fixed

- Crash-recovered recordings could fail to open or upload: a capture sidecar killed mid-write left track files with zeroed or missing WAV headers. Headers are now rebuilt from a frozen per-track format table, so every reader (mixdown, per-track picker, reprocessing, playback) sees the real audio again.
- Clearing the local recordings cache no longer deletes the audio behind saved recordings — only session directories that never produced a note are removed, and pending cloud uploads keep their source file.
- Tray "start recording" failures (permission denied, no audio device, capture engine error) now surface as a toast instead of reading as a dead click. The crash-recovery prompt stays dismissed for the rest of the app run once closed, and a failed recovery attempt re-prompts instead of silently retiring the stranded audio.

## 1.0.8 (2026-09-21)

### New Features

- Windows local transcription gets a GPU path: the whisper engine ships with a Vulkan-enabled runtime archive (vulkan-1.dll included), the default local STT engine is now chosen per platform, and whisper models are installable from the plugin marketplace.
- The Settings card shows the WorkBuddy profile (nickname and avatar, first-letter placeholder when no avatar is set). WorkBuddy OpenAPI traffic now runs through the desktop relay — the endpoint returns no CORS headers, so webview calls could never reach it directly.

### Fixed

- Windows: the app could quit by itself mid-recording. When every webview window was destroyed at once (a WebView2 browser-process crash does exactly that), Tauri exited the process silently and the recording died with it. An active recording now blocks that exit and re-creates the island window as the on-screen control surface; a second app launch focuses the running instance instead of stacking another hidden process, and window-destroy/exit events are logged so any recurrence is diagnosable from the log file.
- Windows: the sidebar's top padding no longer reserves space for the macOS traffic lights it does not have.

## 1.0.7 (2026-09-20)

### Fixed

- Windows: the recording island (capsule and expanded transcript drawer) was see-through — the translucent surface assumes a native frosted material that only exists on macOS, and without it the desktop showed straight through with no blur. The surface now falls back to a near-opaque card whenever the native material is absent.

## 1.0.6 (2026-09-20)

### New Features

- WorkBuddy joins the chat page. The assistant picker at the top now reads 小灵助手 and switches to Work buddy, and the conversation runs through your authorized WorkBuddy account — ask it for a document and it arrives as an attachment in the reply. When authorization is missing, the chat itself walks you through it instead of sending you to settings.
- The About page shows what's new: the published release notes are read from the update source (CloudBase) and displayed next to the version, so checking for updates also tells you what you would be getting.

### Changed

- Live translation switches to the qwen3.8-livetranslate-flash-realtime model; older sessions keep working through the migration, and a toast confirms which engine is actually serving the session.
- The voice-enhancement control on the recording page is a real switch now, with a slash-marked icon for the off state instead of a caption toggle.

### Fixed

- Windows: the About and Feedback windows that sometimes failed to appear now surface an error toast and fall back to the in-app dialog / feedback board instead of doing nothing.
- Windows: the recording island anchors above the taskbar and grows upward — capsule at the bottom edge, live transcript unfolding above it, mirroring the macOS layout.
- Live translation reports capture-layer failures (missing microphone, wedged engine) as a toast before recording starts, so the reason is visible rather than buried in the corner alert.
- Windows capture logging gained step markers (probe results, track writers opened) so a start that hangs on one machine can be told apart from a start that fails.

## 1.0.5 (2026-09-20)

### New Features

- Playback audio is a real master now. Each recording writes `master.wav` — 48 kHz stereo, the echo-cancelled microphone folded into the system audio at unity gain with the voice centred — and it is what playback and upload use. The 16 kHz tracks go back to what they were always meant to be: input for recognition only, not something you listen to.
- Speech enhancement on the microphone path (WebRTC noise suppression + high-pass), reached from a switch beside the start-recording line. Off by default, because archiving faithfully was judged more useful than archiving quietly: mild suppression measures ≈13.8 dB less noise floor for ≈2.8 dB of near-end level, aggressive ≈19.7 dB for ≈3.8 dB. The raw tracks are never touched by it, so a recording can be reprocessed with enhancement off afterwards. Applies to the microphone only — system audio is a digital source and suppression would only damage it.
- The microphone is captured through the same Core Audio path as the system's own recorder (via `AVAudioEngine`); ScreenCaptureKit keeps just the system audio. The old capture route stays reachable behind `--mic-sck` for A/B comparison on one machine.
- Plugin architecture: engines and integrations register through a plugin host with install/enable lifecycle hooks and migrations, surfaced in a community section of settings — including model cards that refuse to delete a model the default engine still references.
- Local transcription grows three routes: the MOSS engine on MLX, a WhisperX engine, and Tencent Cloud real-time recognition as a streaming provider. WorkBuddy joins the sign-in methods.
- Dual-channel echo-cancelled recording is in place on both platforms (raw 48 kHz tracks + a processed recognition track, with a `tracks.json` manifest that Windows and macOS read the same way).

### Changed

- Echo cancellation defaults to off on macOS (`LYNSE_AEC=1` to enable) until it passes a listening acceptance: measured against silent system audio it removed only ~1 dB of echo while leaving processing artefacts in the archive, and the capture without it showed zero clipping, no impulse events and a self-consistent timeline.

### Performance

- MOSS-on-MLX transcription runs chunked prefill and batched audio-tower forward passes, which is what makes long recordings fit in memory; generation reports per-token progress instead of going quiet.

### Fixed

- Every single-microphone recording used to crash on finalize, so its WAV header was never written back and the file played as an unknown length. The gap arithmetic that trapped has been replaced with a real sequential-append interface, and absurd timestamps are now treated as callback jitter rather than as licence to pad in gigabytes of silence.
- Card recordings decoded their Opus payload against a 20 ms buffer while devices negotiate 40 ms, so every packet failed to decode and became silence — the upload "succeeded" with empty content. The decode buffer covers 120 ms.
- WAV reading walks the chunk list instead of assuming a 44-byte header, and tracks declared length separately from on-disk length, so a header left with a zero-length data section (killed mid-finalize) self-heals before persist and before offline reprocessing. Raw tracks are covered too — they were the case where reprocessing failed *after* deleting the finished output.
- Cloud sync keeps the raw tracks and the master and clears only the 16 kHz recognition tracks, instead of deleting the 48 kHz audio along with any chance to reprocess.
- Windows: switching echo cancellation off no longer panics looking for `mic_raw.wav` and no longer leaves `mic.wav` open but unwritten.
- The audio editor stops upsampling 16 kHz sources to 44.1 kHz.
- Recording no longer silently attaches recognition: opening the Dynamic Island drawer no longer switches the session to live, the recording page starts capture before minting credentials, and an unreachable provider is now a toast rather than an empty meeting.
- Interpolation placeholders in every locale were corrected to the `{{ }}` form, so counted and named strings stop rendering their placeholders.

## 1.0.4 (2026-09-14)

### New Features

- Sign-in options and a redesigned login page: phone with SMS code, QR code, and WeChat. The API configuration page replaced a hand-typed server URL with a test/production preset selection that applies to the running session and persists.
- Feishu (Lark) bot integration: long-connection setup with read/write config, start/stop and a connection test; answers stream into cards as a typewriter effect, and a one-click reset clears the secret and restores defaults so the bot can be re-registered. The app secret is kept in secure storage.
- An audio editing page: cut, merge and silence removal, with export able to overwrite the original recording.
- Storage management, to see what is on disk and open the storage location directly.
- Qwen3-ASR on MLX becomes the default local transcription engine, installed into the MLX environment on first use; note, audio and capture content converge on one storage root with a migration for existing data.
- A help-and-feedback window in the app, in all five languages.
- Theme follows the system by default and the native window appearance is kept in sync; gateway `{ code, msg }` error wrappers are decoded into readable messages instead of raw payloads.

### Changed

- In-app updates and the STT runtime archives are served from Tencent CloudBase static hosting with GitHub Releases as fallback, because GitHub downloads are blocked or throttled from mainland China; the release workflow mirrors both to CloudBase and rewrites `latest.json`.
- An API-key login entry is available in development builds only, and the endpoint fallback chain is saved address → build-time environment → production default.
- A recording session with no transcript text is saved as `recorded` rather than being mislabelled as finished.
- Bot events were folded into one channel event stream with a `reason` alongside each status; live-transcription playback files are named by the time the recording ended.

### Fixed

- macOS App Store signing: nested executables are signed with stable identifiers and the audio-capture helper gets `app-sandbox` + `inherit`, so the sandboxed build launches.
- Build-number parsing is hardened so a corrupted plist cannot leak XML into the interface, and the screen-recording / system-audio usage descriptions match macOS 15+.

## 1.0.3 (2026-09-10)

### New Features

- Meeting auto-record: a platform meeting detector (macOS and Windows) starts a recording when a meeting starts, configured from a settings card.
- QR-code sign-in, global search across the library, and a weather card on the home page.
- A Playwright end-to-end suite with a mock server and scripted scenarios covering chat, navigation and recording flows.

### Changed

- The chat transport and chat store were reworked around multi-turn history and streaming; the markdown vault mirror was extended accordingly.
- The Apple build number is decoupled from the version string — decimal and auto-incremented.

### Fixed

- Mind-map images render again in summaries (a bogus URI scheme was stripped and the markdown image syntax dropped); summary content padding tightened.

## 1.0.0 (2026-09-09)

### New Features

- An editorial typography system for notes and summaries, with switchable themes.
- A frosted-glass float dock that keeps transport controls available while the window is hidden.
- The desktop app moves from 0.x to 1.x versioning.

## 0.1.33 (2026-09-07)

### New Features

- Inspiration (灵感速记): saved cards are no longer read-only thumbnails — clicking one opens a detail sheet with the full text, tags, voice memo and every attachment, and from there you can **edit** the note: a Markdown editor for the text, tag chips, and a keep-list of images where you can delete existing ones (removed files are pruned from disk) or add new ones. **Delete** is available from the same sheet.
- Inspiration images open in a lightbox: click an image on a card and it opens full-screen with left/right paging (← / →) and Esc to close, instead of the click falling through to navigating into the note.
- Settings → About gained **Report an issue** and **View logs**. "Report an issue" opens GitHub with a pre-filled, structured bug report carrying the app version, platform, user agent and timestamp (the issue form itself moved from free-form Markdown to a required-field YAML template), so reports arrive reproducible; "View logs" reveals the log folder in Finder/Explorer for attaching evidence.

### Changed

- Diagnostics now land in one persistent file. Everything written to `console.error` / `console.warn`, plus uncaught exceptions and unhandled promise rejections in the webview — including third-party library noise — is forwarded through `tauri-plugin-log` into the same file the Rust side writes, so a bug report only ever needs one folder. The bridge swallows its own failures instead of rethrowing them, so logging can never turn into an unhandled-rejection feedback loop.
- Rust panics are persisted too: the previous default hook wrote only to stderr, which is invisible for a packaged app launched from Finder. Log rotation keeps archived files so crash history survives post-mortem.
- The inspiration page is split into focused modules (card list, detail/edit sheet, lightbox, voice player, date formatting) instead of one large file.

### Fixed

- Voice-memo capture now builds on Windows: the `cpal::Stream` (deliberately `!Send`) is constructed inside the capture thread instead of being moved into `thread::spawn`, `cpal::Sample` is imported where `f32::from_sample` is used, and the `MutexGuard` is dropped before `.await` in `inspiration_voice_cancel` so the command future stays `Send`. macOS was unaffected; the Windows MSI build was broken by these since the feature landed.

## 0.1.32 (2026-09-06)

### New Features

- Update dialog: a single in-place update dialog now opens from every entry point — notification center, profile menu ("Check for updates"), sidebar, and settings — instead of routing through Settings → About. It shows what's new, then downloads, signature-verifies, installs and relaunches without leaving the page, with Later / Close / Retry actions (en / ja / zh).

### Performance

- Recording waveform: the band scrolls at a continuous 62 px/s instead of jumping in 200 ms steps — a local clock extrapolates between the capture sidecar's updates (clamped, frozen while paused), the mic level is smoothed with a fast attack / slow release plus peak-hold, and canvas size, theme colours and the bar path are cached so no frame forces a layout read.
- Elapsed timer: the `MM:SS.cs` readout now ticks at display refresh rate (`SmoothTimer` writes the interpolated value straight to the DOM) instead of stuttering five times a second.
- Live transcript feed is memoized with stable callbacks, so the 5 Hz level/elapsed updates no longer re-render long transcripts.

## 0.1.31 (2026-09-06)

### New Features

- Recording page: the pure-recording stage is redesigned after the iOS Voice Memos / Huawei recorder UI — a time ruler over a full-width waveform band with a red centre playhead, a large `MM:SS.cs` centisecond timer, and a proper transport bar (bookmark · stop · pause) while recording. Bookmarks drop red markers on the waveform band floor and clear when the session ends; the waveform freezes while paused and truncates on restart.
- Chat: opening Chat from the sidebar now lands on the conversation the unread badge points at (latest unread, else the most recent) instead of a blank new-chat view, and chat notifications deep-link straight into their conversation.

### Changed

- The notes audio player scrubber is restyled: neutral muted bars with a red playhead, replacing the previous primary-tinted look.

## 0.1.30 (2026-09-06)

### New Features

- Notes list: recordings whose transcription has finished but that you have not opened yet now show a small red dot (list and grid view). Opening the note clears it.
- In-app auto-update: the app now checks GitHub Releases for new versions and can download, signature-verify, install, and relaunch itself — no more manual download in the browser. Update prompts appear in the sidebar reminder card and the settings About tab, with live download progress. Clients on 0.1.29 or older still use the manual flow; from 0.1.30 on, upgrading is one click.
- Releases are now minisign-signed and published with an update manifest (latest.json) by CI on every version tag.

### Fixed

- Right-click → Delete on a recording in the notes list now also removes local (on-device) transcriptions; previously those deletes were sent to the cloud API with a local id and silently failed, so the row never disappeared. Delete failures now surface as a toast instead of doing nothing.

### Changed

- The Inspiration and Devices features are temporarily hidden while they are being finished; they will return in a future release.


## 0.1.29 (2026-09-01)

### New Features

- Notes list: right-click a note (list or grid view) to delete it or move it to another group. The filter dropdown now shows each group's recording count, and the header keeps the current group's name and count visible while browsing.
- Transcription/summary completion now leaves a "《name》转写完成" entry in the notification center (Bell), so finishing pipelines are no longer signaled only by a fleeting toast — this covers the generate button, the summary dialog flows, and batch transcription from the file list.

### Fixed

- Un-transcribed recordings once again fill the content panel width in the notes page; previously the audio player and generate button collapsed into a narrow left column with a large blank area on the right (the panel sized itself to its content instead of stretching).
- The notes list now refreshes after generation, rename, delete, or move-to-group, so titles update instead of going stale until reload.
- Chat notifications from the AI assistant now carry the assistant's mascot avatar instead of a generic message icon, and blank conversation titles no longer render empty 《》 brackets.

### Changed

- Profile dropdown: the membership row now shows remaining credits; removed the redundant "Check for Updates" item (startup auto-check, notification center, and the About tab already cover it).

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
