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
import { createElement, forwardRef } from "react";
import { createLucideIcon, type LucideIcon, type LucideProps } from "lucide-react";

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
  MessageSquarePlus, // Feature request / feedback board entry
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
  ZoomIn,           // Image viewer zoom in
  ZoomOut,          // Image viewer zoom out
  Fullscreen,       // Image viewer fit to window

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
  CodeXml,          // Source view toggle (</>)
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
  SkipBack,         // Rewind / skip back
  SkipForward,      // Fast forward / skip
  Volume2,          // Volume on
  VolumeX,          // Volume off / mute
  Captions,         // Live transcription toggle
  CaptionsOff,      // Live transcription toggle (off / exit state)
  Speech,           // Microphone speech-enhancement toggle (a person speaking)
  Languages,        // Live translation switch (speech → translated text)

  // ── Actions (extra) ──────────────────────────────────
  RefreshCw,        // Re-summarize / refresh
  Maximize2,        // Expand island back to the full window
  EyeOff,           // Hide main window into the recording island
  Square,           // Stop streaming
  Terminal,         // Terminal / shell tool activity
  SquareTerminal,   // Boxed terminal prompt (chat tool activity)
  Plug,             // MCP tool-call activity
  Wrench,           // Generic tool-call activity (execute fallback)
  Brain,            // Thinking / reasoning trace (chat tool activity)
  FileSearch,       // File read tool activity (chat tool activity)
  ScrollText,       // Background task output (chat tool activity)
  CircleStop,       // Stop / cancel task (chat tool activity)
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
  KeyRound,         // API-key sign-in entry

  // ── Plugins ──────────────────────────────────────────
  Puzzle,           // Plugins community (Settings → Plugins)

  // ── Audio Editor ─────────────────────────────────────
  Scissors,         // Trim selection
  Combine,          // Merge multiple audios
  Wand2,            // Voice enhancement
  Crop,             // Zoom the view to the trim selection
  ArrowLeft,        // Back to previous page
} from "lucide-react";

// ── Custom icons ─────────────────────────────────────────
// lucide has no SpeechOff yet; mirror the official *Off pattern
// (CaptionsOff et al.): the base icon's paths plus a corner-to-corner
// diagonal slash.
export const SpeechOff: LucideIcon = createLucideIcon("speech-off", [
  [
    "path",
    {
      d: "M8.8 20v-4.1l1.9.2a2.3 2.3 0 0 0 2.164-2.1V8.3A5.37 5.37 0 0 0 2 8.25c0 2.8.656 3.054 1 4.55a5.77 5.77 0 0 1 .029 2.758L2 20",
    },
  ],
  ["path", { d: "M19.8 17.8a7.5 7.5 0 0 0 .003-10.603" }],
  ["path", { d: "M17 15a3.5 3.5 0 0 0-.025-4.975" }],
  ["path", { d: "m2 2 20 20" }],
]);

// lucide 1.41 has no "note with a plus" glyph (NotebookPlus landed in later
// releases), so compose one: the StickyNote outline with a plus set into the
// body below the folded corner. Used for "file this reply into my notes".
export const NotePlus: LucideIcon = createLucideIcon("note-plus", [
  [
    "path",
    {
      d: "M21 9a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z",
    },
  ],
  ["path", { d: "M15 3v5a1 1 0 0 0 1 1h5" }],
  ["path", { d: "M12 11.5v6" }],
  ["path", { d: "M9 14.5h6" }],
]);

// Official WorkBuddy brand mark (workbuddy.cn), kept in full color. The
// gradient/glow/clipped-badge structure needs nested <defs>, which lucide's
// flat icon-node format cannot express, so this is a hand-rolled component
// with the same LucideIcon signature. It always paints brand colors —
// text-* utility classes on it are no-ops.
const WORKBUDDY_MARK =
  "M28.5931 3.12762C28.9853 2.77585 29.0091 2.76226 29.2968 2.74499C29.7628 2.71096 30.1894 2.93488 30.916 3.59634C32.6132 5.13875 34.9769 8.30904 36.4462 11.0168L37.0138 12.0682L37.8156 12.4668C38.5896 12.8579 39.8593 13.6593 40.3898 14.0895C40.6297 14.2878 40.6638 14.2925 40.9133 14.1954C42.0388 13.7572 43.6506 14.3382 45.0727 15.7024C46.3529 16.9294 47.5794 19.026 48.0491 20.7757C48.1177 21.0574 48.2087 21.6628 48.2419 22.1134C48.349 23.6964 47.8414 24.9608 46.8637 25.5331C46.664 25.6484 46.6505 25.6795 46.6561 26.1774C46.7011 28.5481 46.0621 30.9144 44.7785 33.2221C43.3293 35.8133 40.7489 38.4945 37.2566 41.0199C35.3813 42.3846 30.9445 44.9701 28.9382 45.8778C24.1324 48.0414 20.2794 48.8709 16.9329 48.4609C14.9368 48.219 12.6769 47.44 11.34 46.5355C10.9885 46.2925 10.9325 46.2774 10.6637 46.3543C9.2327 46.7651 7.35867 45.9207 5.76659 44.1535C5.13165 43.4471 4.1065 41.7127 3.77404 40.7843C3.0054 38.6118 3.15852 36.6506 4.18236 35.4799C4.44671 35.1785 4.45511 35.1658 4.39735 34.6589C4.30195 33.8289 4.25837 32.6008 4.30192 31.808L4.33666 31.0674L3.22502 29.101C1.5033 26.0375 0.409325 23.4645 -0.012563 21.4992C-0.235219 20.4218 -0.221193 19.9436 0.0522186 19.5899C0.21871 19.3763 0.764928 19.1545 1.42322 19.0329C3.08041 18.742 6.69466 19.0056 10.7155 19.7155L11.1329 19.788L12.0511 18.976C13.5747 17.6264 14.587 16.8696 16.4531 15.706C18.3981 14.4891 20.5929 13.4877 23.0648 12.695L23.8577 12.4414L24.2939 11.2964C25.8547 7.17615 27.4533 4.13844 28.5931 3.12762ZM15.5182 24.243C13.7542 25.2615 12.8718 25.7706 12.2236 26.3413C9.59893 28.6526 8.61811 32.3134 9.73545 35.6274C10.0114 36.4457 10.5201 37.3283 11.5386 39.0923C12.5571 40.8564 13.0671 41.7383 13.6378 42.3864C15.9491 45.0112 19.6103 45.9929 22.9243 44.8755C23.7426 44.5995 24.6249 44.0899 26.3888 43.0714L36.5375 37.2121C38.3016 36.1936 39.184 35.6845 39.8321 35.1137C42.4568 32.8024 43.4373 29.1409 42.3198 25.8269C42.0438 25.0086 41.5342 24.1264 40.5158 22.3624C39.4973 20.5983 38.9882 19.7159 38.4175 19.0678C36.1062 16.4432 32.4454 15.4622 29.1314 16.5796C28.3131 16.8556 27.431 17.3651 25.6669 18.3836L15.5182 24.243Z";

export const WorkBuddy: LucideIcon = forwardRef<SVGSVGElement, LucideProps>(
  function WorkBuddy({ size = 24, className, ...props }, ref) {
    const labelled = props["aria-label"] != null;
    return createElement(
      "svg",
      {
        ref,
        width: size,
        height: size,
        viewBox: "0 0 40 40",
        fill: "none",
        className,
        "aria-hidden": labelled ? undefined : true,
        ...props,
      },
      createElement(
        "defs",
        null,
        createElement(
          "linearGradient",
          { id: "workbuddy-bg-grad", x1: "20", y1: "0", x2: "20", y2: "40", gradientUnits: "userSpaceOnUse" },
          createElement("stop", { stopColor: "#0EC8A9" }),
          createElement("stop", { offset: "1", stopColor: "#01C886" }),
        ),
        createElement(
          "linearGradient",
          { id: "workbuddy-mark-grad", x1: "14.6642", y1: "11.0783", x2: "33.3762", y2: "43.4885", gradientUnits: "userSpaceOnUse" },
          createElement("stop", { stopColor: "white", stopOpacity: "0.8" }),
          createElement("stop", { offset: "0.437689", stopColor: "white" }),
        ),
        createElement("clipPath", { id: "workbuddy-badge-clip" }, createElement("rect", { width: "40", height: "40", rx: "20" })),
        createElement(
          "filter",
          { id: "workbuddy-glow-blur", x: "7.47033", y: "19.7475", width: "47.742", height: "47.7416", filterUnits: "userSpaceOnUse", colorInterpolationFilters: "sRGB" },
          createElement("feGaussianBlur", { stdDeviation: "5.50019" }),
        ),
      ),
      createElement(
        "g",
        { clipPath: "url(#workbuddy-badge-clip)" },
        createElement("rect", { width: "40", height: "40", rx: "20", fill: "url(#workbuddy-bg-grad)" }),
        createElement("circle", { cx: "31.3411", cy: "43.6183", r: "12.8704", fill: "#FFE355", fillOpacity: "0.49", filter: "url(#workbuddy-glow-blur)" }),
        createElement("path", { d: WORKBUDDY_MARK, fill: "url(#workbuddy-mark-grad)" }),
        createElement("rect", { x: "16.4961", y: "31.3344", width: "4.00904", height: "8.32646", rx: "2.00452", transform: "rotate(-30 16.4961 31.3344)", fill: "white" }),
        createElement("rect", { x: "27.3125", y: "25.0894", width: "4.00904", height: "8.32646", rx: "2.00452", transform: "rotate(-30 27.3125 25.0894)", fill: "white" }),
      ),
    );
  },
);

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

export type { LucideIcon } from "lucide-react";
