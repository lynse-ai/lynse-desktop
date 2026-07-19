import { invoke } from "@tauri-apps/api/core";
import type { StorageAdapter } from "@lynse/core/types/storage";

/**
 * Keys that must never live in clear text in localStorage. They are stored in
 * the OS keychain (macOS Keychain / Windows Credential Manager) and only ever
 * held in this in-memory cache on the webview side.
 */
const SECRET_KEYS = new Set(["lynse_api_key", "lynse_token"]);

const secretCache = new Map<string, string>();

async function secureGet(account: string): Promise<string | null> {
  try {
    return await invoke<string | null>("secure_get_secret", { account });
  } catch {
    return null;
  }
}

async function secureSet(account: string, value: string): Promise<void> {
  await invoke("secure_set_secret", { account, value });
}

async function secureDelete(account: string): Promise<void> {
  try {
    await invoke("secure_delete_secret", { account });
  } catch {
    /* entry may already be missing */
  }
}

/**
 * Load secrets from the OS keychain into the in-memory cache *before* the app
 * renders, so the synchronous `StorageAdapter` contract still holds for the
 * auth store. Also migrates any plaintext secrets left in localStorage by older
 * builds into the keychain and removes them, so nothing sensitive is persisted
 * in clear text anymore.
 */
export async function hydrateSecrets(): Promise<void> {
  for (const key of SECRET_KEYS) {
    const fromKeychain = await secureGet(key);
    if (fromKeychain != null) {
      secretCache.set(key, fromKeychain);
    }

    if (typeof window !== "undefined") {
      const legacy = window.localStorage.getItem(key);
      if (legacy) {
        if (fromKeychain == null) {
          secretCache.set(key, legacy);
          await secureSet(key, legacy).catch(() => undefined);
        }
        window.localStorage.removeItem(key);
      }
    }
  }
}

/**
 * Desktop storage adapter: secret keys are routed to the OS keychain (via a
 * synchronous in-memory cache that is hydrated at startup), everything else
 * falls through to localStorage. This keeps the shared `StorageAdapter`
 * contract synchronous while moving credentials out of clear text.
 */
export const secureStorage: StorageAdapter = {
  getItem(key: string): string | null {
    if (!SECRET_KEYS.has(key)) {
      return typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    }
    return secretCache.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    if (!SECRET_KEYS.has(key)) {
      if (typeof window !== "undefined") window.localStorage.setItem(key, value);
      return;
    }
    secretCache.set(key, value);
    void secureSet(key, value).catch((error) => console.error(`[secure-storage] failed to persist ${key}`, error));
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
  },
  removeItem(key: string): void {
    if (!SECRET_KEYS.has(key)) {
      if (typeof window !== "undefined") window.localStorage.removeItem(key);
      return;
    }
    secretCache.delete(key);
    void secureDelete(key).catch(() => undefined);
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
  },
};
