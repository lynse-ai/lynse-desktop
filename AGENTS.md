# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Context

Lynse is a meeting knowledge management platform — recording, transcription, notes, and AI assistance.

- Upload and manage audio/video recordings
- Organize meeting notes with Markdown editor
- AI chatbot for querying recordings and knowledge base
- File management with cloud storage integration

## Architecture

**Monorepo frontend (pnpm workspaces + Turborepo) with shared packages.**

- `apps/web/` — Next.js frontend (App Router)
- `apps/tauri/` — Tauri 2 desktop app (Rust shell + Vite renderer). Native capabilities — local FunASR transcription, voiceprints, hotwords, `local-media://` streaming — live in `apps/tauri/src-tauri/src/lib.rs`.
- `packages/ui/` — Atomic UI components (shadcn, Base UI). Extracted from Multica's design system.
- `packages/views/` — Shared business pages/components (zero next/* imports, zero react-router imports)
- `packages/core/` — Headless business logic: API client, auth, navigation, platform layer
- `packages/tsconfig/` — Shared TypeScript configuration

### Key Patterns (inherited from Multica)

**Internal Packages** — shared packages export raw `.ts`/`.tsx` files (no pre-compilation). The consuming app's bundler compiles them directly.

**Dependency direction:** `views/ → core/ + ui/`. Core and UI are independent.

**Platform bridge:** `packages/core/platform/` provides `CoreProvider` — initializes API client, auth store, and QueryClient. Each app wraps its root with `<CoreProvider>` and provides its own `NavigationAdapter` for routing.

**pnpm catalog** — `pnpm-workspace.yaml` defines `catalog:` for version pinning.

### State Management

- **TanStack Query** owns all server state (recordings, meetings, notes, files)
- **Zustand** owns all client state (UI selections, filters, drafts)
- **React Context** is reserved for platform plumbing (`NavigationProvider`, `WorkspaceIdProvider`)

### Package Boundaries

- `packages/core/` — zero react-dom, zero localStorage (use StorageAdapter), zero process.env
- `packages/ui/` — zero `@lynse/core` imports (pure UI)
- `packages/views/` — zero `next/*` imports, zero `react-router-dom` imports. Use `NavigationAdapter` for all routing.
- `apps/web/platform/` — the only place for Next.js APIs (`next/navigation`)
- `apps/tauri/src/platform/` — the only place for desktop navigation wiring (state-based `NavigationAdapter`)

## Commands

```bash
# Install dependencies
pnpm install

# Development
pnpm dev:web          # Next.js dev server (port 3000)
pnpm dev:desktop      # Tauri desktop dev (alias of dev:tauri)

# Build
pnpm build            # Build all apps

# Checks
pnpm typecheck        # TypeScript check (all packages + apps via turbo)
pnpm lint             # ESLint
pnpm test             # TS tests (Vitest)

# shadcn — add UI components
pnpm ui:add badge     # Adds component to packages/ui/components/ui/

# Desktop packaging (Tauri)
pnpm --filter @lynse/tauri build       # Build + bundle into .app/.dmg (Rust + Vite)
```

## Coding Rules

- TypeScript strict mode is enabled; keep types explicit.
- Keep comments in code English only.
- Prefer existing patterns/components over introducing parallel abstractions.
- Use shadcn design tokens for styling. Avoid hardcoded color values.
- If a component is identical between web and desktop, it belongs in a shared package.

## Navigation

All shared code uses `useNavigation().push()` or `<AppLink>` for navigation. Never use framework-specific link/router APIs in shared code.

## Next Steps (TODO)

These are the areas that need implementation:

1. **Markdown Editor** — integrate Tiptap (already listed as views dependency) for rich note editing
2. **File Upload/Management** — connect to your backend's file API endpoints
3. **AI Chat** — connect the chat page to your AI backend (streaming responses)
4. **Recording Transcription** — add audio/video upload + transcription display
5. **Real API Integration** — replace placeholder pages with real data fetching using TanStack Query
6. **i18n** — the locale infrastructure is set up, expand translation strings as needed
