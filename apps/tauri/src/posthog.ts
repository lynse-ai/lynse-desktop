import posthog from "posthog-js";

const key = import.meta.env.VITE_POSTHOG_KEY;
const host = import.meta.env.VITE_POSTHOG_HOST;
const configured = Boolean(key && host);

if (!key || !host) {
  if (import.meta.env.DEV) {
    const missingVariable = !key ? "VITE_POSTHOG_KEY" : "VITE_POSTHOG_HOST";
    throw new Error(
      `${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`,
    );
  }
} else {
  posthog.init(key, {
    api_host: host,
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    logs: {
      serviceName: "lynse-desktop-renderer",
      environment: import.meta.env.MODE,
    },
  });
}

/** Only purpose-written records from this integration use the PostHog Logs sink. */
const posthogLogs = {
  rendererBooted: () => {
    if (configured) posthog.logger.info("renderer bootstrap completed");
  },
  localTranscriptionStarted: () => {
    if (configured) posthog.logger.info("local transcription started");
  },
  liveTranslationStarted: () => {
    if (configured) posthog.logger.info("live translation started");
  },
};

export { posthog, posthogLogs };
