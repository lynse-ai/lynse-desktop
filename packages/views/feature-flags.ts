/**
 * Release gates for work-in-progress features.
 *
 * Flip a flag to `true` to expose the feature again (sidebar entry + route).
 * Keep this the single source of truth — every entry point must gate on it so
 * a feature can be shipped or hidden by editing this file only.
 */
export const featureFlags = {
  /** Inspiration page (`/inspiration`) — hidden until the feature is complete. */
  inspiration: false,
  /** Devices page (`/devices`) — hidden until the feature is complete. */
  devices: false,
} as const;
