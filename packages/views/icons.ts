/**
 * Centralized icon registry for the Lynse views layer.
 *
 * All view components should import icons from this file instead of
 * importing directly from "lucide-react". This keeps icon choices
 * consistent across the app and makes it trivial to swap icons later.
 *
 * Naming convention: use the original lucide-react name (PascalCase,
 * no `Icon` suffix). The shadcn/ui primitives inside `@lynse/ui`
 * import with the `Icon` suffix — that is fine, those are internal
 * to the UI layer.
 */
export {
  // ── Navigation / Sidebar ──────────────────────────────
  Headphones,       // Recordings
  CalendarDays,     // Meetings
  BookOpen,         // Knowledge Base
  FolderOpen,       // Files / Folders
  MessageSquare,    // AI Chat
  Settings,         // Settings
  LogOut,           // Log out
  Grid3X3,          // Grid view toggle
  Circle,           // Dot indicators
  Layers,           // All Files virtual folder
  Trash2,           // Trash virtual folder
  FolderPlus,       // Add folder button

  // ── Chevron / Disclosure ──────────────────────────────
  ChevronDown,
  ChevronRight,

  // ── Actions ───────────────────────────────────────────
  Plus,             // Create / Add
  Search,           // Search inputs
  Filter,           // Filter controls
  Send,             // Send message (chat)
  X,                // Close / Dismiss
  Upload,           // Upload action
  Copy,             // Copy to clipboard
  Check,            // Confirm / Copied
  Pencil,           // Rename / Edit inline
  MoreHorizontal,   // Context menu trigger

  // ── Content / Document ────────────────────────────────
  FileText,         // Generic document / file
  FileAudio,        // Audio transcription
  Sparkles,         // AI-generated summary
  List,             // Outline / TOC
  Eye,              // Preview mode
  Columns2,         // Split mode
  Bot,              // AI assistant

  // ── Misc ──────────────────────────────────────────────
  Loader2,          // Spinner (animate-spin)
  Sun,              // Light theme
  Moon,             // Dark theme
  Monitor,          // System theme
  Globe,            // Language
  HelpCircle,       // Help docs
  FileClock,        // Changelog
  MessageCircle,    // Feedback

  // ── Audio Player ────────────────────────────────────
  Play,             // Play
  Pause,            // Pause
  SkipForward,      // Fast forward / skip
  Volume2,          // Volume on
  VolumeX,          // Volume off / mute
} from "lucide-react";

// ── Icon sizing tokens ────────────────────────────────────
// Use these class strings to keep icon sizes consistent:
//   ICON_XS  →  size-3     (12 px)  inline indicators, badge icons
//   ICON_SM  →  size-3.5   (14 px)  sidebar items, tab buttons, search
//   ICON_MD  →  size-4     (16 px)  standard buttons, default
//   ICON_LG  →  size-5     (20 px)  empty-state circles, hero icons
//   ICON_XL  →  size-6     (24 px)  large standalone icons
export const ICON_XS = "size-3";
export const ICON_SM = "size-3.5";
export const ICON_MD = "size-4";
export const ICON_LG = "size-5";
export const ICON_XL = "size-6";
