import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface QoderEnabledState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
  toggle: () => void;
}

/**
 * Whether the Qoder Cloud Agent chat channel is enabled.
 *
 * The chat transport factory in `use-chat` reads this to choose between the
 * Qoder channel and the default cloud channel. Persisted to localStorage so
 * the choice survives reloads.
 *
 * Defaults to `true` to preserve the current desktop behaviour (the desktop
 * app already routes to Qoder whenever the bridge is available); the switch
 * exists so users can fall back to the cloud channel.
 */
export const useQoderEnabledStore = create<QoderEnabledState>()(
  persist(
    (set, get) => ({
      enabled: true,
      setEnabled: (enabled) => set({ enabled }),
      toggle: () => set({ enabled: !get().enabled }),
    }),
    {
      name: "lynse_qoder_enabled",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

/** Synchronous read for non-React call sites (e.g. the transport factory). */
export function isQoderEnabled(): boolean {
  try {
    return useQoderEnabledStore.getState().enabled;
  } catch {
    return false;
  }
}
