# Changelog

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
