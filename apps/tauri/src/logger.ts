import { error as logError, info as logInfo, warn as logWarn } from "@tauri-apps/plugin-log";

/**
 * Forward frontend failures into the persistent log file (tauri-plugin-log):
 * uncaught exceptions, unhandled promise rejections, and everything written
 * to console.error / console.warn — including diagnostics from third-party
 * libraries. The Rust side feeds the same file, so one log captures both.
 *
 * Delivery is best-effort: a broken IPC sink is swallowed (and disables
 * further sends) instead of rethrown, so the log bridge itself can never
 * become the source of an unhandled rejection feedback loop.
 */
export function installLogger(source: string): void {
  let sinkHealthy = true;
  const send = (level: "error" | "warn" | "info", message: string) => {
    if (!sinkHealthy) return;
    const deliver = level === "error" ? logError : level === "warn" ? logWarn : logInfo;
    deliver(message).catch(() => {
      sinkHealthy = false;
    });
  };

  logInfo(`[webview:${source}] session started`).catch(() => {
    sinkHealthy = false;
  });

  window.addEventListener("error", (event) => {
    const detail =
      event.error instanceof Error && event.error.stack
        ? event.error.stack
        : `${event.message} (${event.filename}:${event.lineno}:${event.colno})`;
    send("error", `[webview:${source}] uncaught error: ${detail}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason =
      event.reason instanceof Error
        ? (event.reason.stack ?? event.reason.message)
        : formatValue(event.reason);
    send("error", `[webview:${source}] unhandled rejection: ${reason}`);
  });

  // Keep the original function so DevTools output stays unchanged.
  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      send(level, `[webview:${source}] console.${level}: ${args.map(formatValue).join(" ")}`);
    };
  }
}

function formatValue(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
