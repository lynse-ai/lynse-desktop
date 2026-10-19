/**
 * Browser-mode Tauri IPC shim for Playwright E2E.
 *
 * Activated only when the Vite build runs with MODE === "e2e" (or
 * VITE_LYNSE_E2E=1) — never part of a dev or packaged build. It emulates the
 * slice of `window.__TAURI_INTERNALS__` that @tauri-apps/api v2 needs, so the
 * real `installTauriBridge()` runs unmodified in a plain browser and every
 * `window.desktopAPI` method routes into the command router below.
 *
 * The secret vault is backed by a localStorage key (NOT the real secret keys,
 * which hydrateSecrets migrates away) so tests can pre-seed a login token the
 * same way the packaged app reads one from the OS keychain.
 *
 * Test hooks are exposed as `window.__LYNSE_E2E__`:
 *   - `emit(event, payload)` — deliver a Tauri event into the app (tray, etc.)
 *   - `setCommand(name, handler)` — override a command's mock response
 */

type InvokeHandler = (args: Record<string, unknown>) => unknown;

interface LynseE2EHooks {
  emit: (event: string, payload?: unknown) => void;
  setCommand: (name: string, handler: InvokeHandler) => void;
}

const COMMAND_PREFIX_STUBS: Array<[RegExp, unknown]> = [
  [/^(local_transcription_list|todo_list|inspiration_list|live_translation_recoveries)$/, []],
  [/^local_stt_model_status$/, { models: [] }],
  [/^storage_usage$/, { items: [] }],
];

/** Handler functions registered for a command name. */
const commandHandlers = new Map<string, InvokeHandler>();

/** Idle snapshot matching LiveTranslationSnapshot — polled at boot. */
const IDLE_LIVE_SNAPSHOT = {
  state: "idle",
  epoch: 0,
  elapsedMs: 0,
  micLevel: 0,
  systemLevel: 0,
  segments: [],
};

/** Callbacks registered through transformCallback, keyed by id. */
const ipcCallbacks = new Map<number, (raw: { event: string; id: number; payload: unknown }) => void>();
/** Event listeners created via plugin:event|listen, keyed by listener id. */
const eventListeners = new Map<number, { event: string; callbackId: number }>();
let nextCallbackId = 0;
let nextListenerId = 100_000;

function defaultInvoke(cmd: string, args: Record<string, unknown>): unknown {
  // Known no-op writes / reads the app makes at boot.
  const nullCommands = new Set([
    "secure_delete_secret",
    "meeting_detector_set_config",
    "meeting_detector_get_state",
    "vault_config_get",
    "vault_default_path",
    "webdav_config_get",
    "bot_config_get",
    "bot_state",
    "feishu_config_get",
    "feishu_state",
    "audio_editor_status",
    "local_stt_config_get",
    "inspiration_voice_state",
  ]);
  if (nullCommands.has(cmd)) return null;
  if (cmd === "secure_get_secret") {
    // Each account is one key in the localStorage-backed map; the value is
    // the raw secret string (or null when absent) — same semantics as the
    // Rust keychain command.
    const account = typeof args.account === "string" ? args.account : "";
    return readVault()[account] ?? null;
  }
  if (cmd === "secure_set_secret") {
    const account = typeof args.account === "string" ? args.account : "";
    const value = typeof args.value === "string" ? args.value : "";
    if (account) {
      const vault = readVault();
      vault[account] = value;
      writeVault(vault);
    }
    return null;
  }
  if (cmd === "secure_update_vault_entry") {
    // Same semantics as the Rust command: set (string) or remove (null) one
    // entry inside the vault map.
    const account = typeof args.account === "string" ? args.account : "";
    if (account) {
      const vault = readVault();
      if (typeof args.value === "string") {
        vault[account] = args.value;
      } else {
        delete vault[account];
      }
      writeVault(vault);
    }
    return null;
  }
  if (cmd === "workbench_bind" || cmd === "workbench_status") return {scope:"synthetic-account",userId:"user-e2e",enabled:false,allowAi:false,initialComplete:false,phase:"disabled",updatedAt:"",error:"",discovered:0,synced:0,awaitingTranscription:0,failed:0,conflicts:0,entries:[],memories:[]};
  if (cmd === "get_app_info") return { version: "0.0.0-e2e", build: "1", platform: "macos" };
  if (cmd === "window_effects_mode") return "none";
  if (cmd === "live_translation_state") return IDLE_LIVE_SNAPSHOT;
  for (const [pattern, value] of COMMAND_PREFIX_STUBS) {
    if (pattern.test(cmd)) return value;
  }
  console.debug(`[e2e-shim] unhandled invoke "${cmd}"`, args);
  return null;
}

// ── secret vault (localStorage-backed) ──────────────────────────────────────

const VAULT_KEY = "__lynse_e2e_secret_vault__";

function readVault(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(VAULT_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeVault(vault: Record<string, string>): void {
  window.localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
}

// ── module-level singleton ──────────────────────────────────────────────────

export function installE2EShim(): void {
  const w = window as unknown as Record<string, unknown>;
  if (w.__LYNSE_E2E__) return;

  w.__TAURI_INTERNALS__ = {
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    transformCallback: (callback: (raw: { event: string; id: number; payload: unknown }) => void) => {
      const id = ++nextCallbackId;
      ipcCallbacks.set(id, callback);
      return id;
    },
    unregisterCallback: (id: number) => {
      ipcCallbacks.delete(id);
    },
    convertFileSrc: (filePath: string) => filePath,
    invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
      switch (cmd) {
        case "plugin:event|listen": {
          const eventId = ++nextListenerId;
          eventListeners.set(eventId, {
            event: typeof args.event === "string" ? args.event : "",
            callbackId: typeof args.handler === "number" ? args.handler : -1,
          });
          return eventId;
        }
        case "plugin:event|unlisten": {
          if (typeof args.eventId === "number") eventListeners.delete(args.eventId);
          return null;
        }
        case "plugin:event|emit":
        case "plugin:event|emit_to":
          return null;
        default: {
          const handler = commandHandlers.get(cmd);
          if (handler) return handler(args);
          return defaultInvoke(cmd, args);
        }
      }
    },
  };

  // @tauri-apps/api v2.11's event plugin keeps its own registry here; the
  // unlisten cleanup crashes with a TypeError when it's missing.
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (event: string, eventId: number) => {
      void event;
      eventListeners.delete(eventId);
    },
    registerListener: (_event: string, eventId: number) => eventId,
  };

  const hooks: LynseE2EHooks = {
    emit(event, payload = null) {
      for (const [listenerId, listener] of eventListeners) {
        if (listener.event !== event) continue;
        const callback = ipcCallbacks.get(listener.callbackId);
        callback?.({ event, id: listenerId, payload });
      }
    },
    setCommand(name, handler) {
      commandHandlers.set(name, handler);
    },
  };
  w.__LYNSE_E2E__ = hooks;
}
