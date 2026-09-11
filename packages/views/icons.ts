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
  House,            // Home / 主页 feed
  Headphones,       // Recordings
  Mic,              // Microphone input
  Camera,           // iPhone photo capture (Continuity Camera)
  CalendarDays,     // Meetings
  BookOpen,         // Knowledge Base
  FolderOpen,       // Files / Folders
  Lightbulb,        // Inspiration
  MessageSquare,    // Generic message placeholder (transcription prompt)
  Settings,         // Settings
  Bluetooth,        // Recording card / devices page
  BatteryFull,      // Device battery (healthy)
  BatteryLow,       // Device battery (low)
  HardDrive,        // Device storage
  Cpu,              // Device firmware
  CircleDot,        // Live recording dot
  Signal,           // RSSI / mark button
  AlertCircle,      // Inline error banner
  LogOut,           // Log out
  Grid3X3,          // Grid view toggle
  LayoutGrid,       // Compact 2x2 grid view toggle
  Circle,           // Dot indicators
  Layers,           // All Files virtual folder
  Trash2,           // Trash virtual folder
  FolderPlus,       // Add folder button
  Hash,             // Note-group mention (# in chat composer)

  // ── Chevron / Disclosure ──────────────────────────────
  ChevronDown,
  ChevronLeft,
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
  GripVertical,     // Drag handle

  // ── Content / Document ────────────────────────────────
  FileText,         // Generic document / file
  FileAudio,        // Audio transcription
  Sparkles,         // AI-generated summary
  List,             // Outline / TOC
  Calendar,         // Date / calendar event
  Eye,              // Preview mode
  Columns2,         // Split mode
  PanelLeft,        // Collapse / expand left sidebar
  Bot,              // AI Chat / AI assistant

  // ── Markdown Toolbar ─────────────────────────────────
  Bold,             // Bold mark
  Italic,           // Italic mark
  Code,             // Inline code
  ListOrdered,      // Ordered list
  ListChecks,       // Task list
  Quote,            // Blockquote
  Image,            // Image insert
  Heading1,         // Heading level 1
  Heading2,         // Heading level 2
  Heading3,         // Heading level 3
  Type,             // Paragraph / body text
  Undo,             // Undo history

  // ── Membership / Credits ──────────────────────────────
  Crown,            // Membership tier
  Zap,              // Credits / points

  // ── Misc ──────────────────────────────────────────────
  Loader2,          // Spinner (animate-spin)
  Sun,              // Light theme
  Moon,             // Dark theme
  Monitor,          // System theme
  Globe,            // Language
  HelpCircle,       // Help docs
  Info,             // About / version info
  FileClock,        // Changelog
  ArrowUpDown,      // Sort toggle
  ArrowDown,        // Sort descending
  ArrowUp,          // Sort ascending
  Clock,            // Time-based sort
  MessageCircle,    // Feedback
  Bell,             // Update reminder
  Download,         // Download / update action
  Palette,          // Appearance / theme visual
  UserCircle,       // User profile / account
  Link,             // Share / copy link
  Share,            // Share action

  // ── Audio Player ────────────────────────────────────
  Play,             // Play
  Pause,            // Pause
  SkipForward,      // Fast forward / skip
  Volume2,          // Volume on
  VolumeX,          // Volume off / mute
  Captions,         // Live transcription toggle
  Languages,        // Live translation switch (speech → translated text)

  // ── Actions (extra) ──────────────────────────────────
  RefreshCw,        // Re-summarize / refresh
  Maximize2,        // Expand island back to the full window
  EyeOff,           // Hide main window into the recording island
  Square,           // Stop streaming
  Terminal,         // Terminal / shell tool activity
  Cloud,            // Cloud assistant
  Repeat,           // Swap / exchange
  ArrowRight,       // Forward / CTA
  Bookmark,         // Bookmark / save position
  LayersArrowDown,  // Sync notes to vault
  ListMusic,        // Recordings list / audio library

  // ── Weather (Home forecast) ──────────────────────────
  MapPin,           // Detected location label
  CloudSun,         // Partly cloudy
  Cloudy,           // Overcast
  CloudFog,         // Fog
  CloudDrizzle,     // Drizzle
  CloudRain,        // Rain / showers
  CloudSnow,        // Snow
  CloudLightning,   // Thunderstorm

  // ── Auth ─────────────────────────────────────────────
  QrCode,           // App-scanned QR-code sign-in entry

  // ── Audio Editor ─────────────────────────────────────
  Scissors,         // Trim selection
  Combine,          // Merge multiple audios
  Wand2,            // Voice enhancement
  ArrowLeft,        // Back to previous page
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
