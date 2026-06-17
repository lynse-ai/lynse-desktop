# Changelog

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
