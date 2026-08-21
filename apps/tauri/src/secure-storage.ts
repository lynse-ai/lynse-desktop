import { invoke } from "@tauri-apps/api/core";
import type { StorageAdapter } from "@lynse/core/types/storage";

/**
 * Keys that must never live in clear text in localStorage. They are stored in
 * the OS keychain (macOS Keychain / Windows Credential Manager) and only ever
 * held in this in-memory cache on the webview side.
 */
const SECRET_KEYS = new Set([
  "lynse_api_key",
  "lynse_token",
  "lynse_live_translation_ilivedata_secret_key",
  "lynse_live_translation_qwen_api_key",
  "lynse_live_translation_volc_api_key",
]);

/**
 * All secrets are stored under ONE keychain entry (a JSON map) instead of one
 * entry per key. macOS shows an authorization prompt per keychain item for an
 * untrusted binary, so the old per-key layout asked for the password several
 * times on every launch; a single vault means at most one prompt.
 */
const VAULT_ACCOUNT = "lynse_secrets_v1";

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

async function vaultLoad(): Promise<Record<string, string>> {
  const raw = await secureGet(VAULT_ACCOUNT);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
    return {};
  } catch {
    return {};
  }
}

function vaultPersist(map: Record<string, string>): void {
  const keys = Object.keys(map);
  if (keys.length === 0) {
    void secureDelete(VAULT_ACCOUNT).catch(() => undefined);
    return;
  }
  void secureSet(VAULT_ACCOUNT, JSON.stringify(map)).catch((error) =>
    console.error("[secure-storage] failed to persist vault", error),
  );
}

/** Rebuild the vault from the in-memory cache and write it to the keychain. */
function persistCacheAsVault(): void {
  const map: Record<string, string> = {};
  for (const key of SECRET_KEYS) {
    const value = secretCache.get(key);
    if (value != null) map[key] = value;
  }
  vaultPersist(map);
}

/**
 * Load secrets from the OS keychain into the in-memory cache *before* the app
 * renders, so the synchronous `StorageAdapter` contract still holds for the
 * auth store. Also migrates any plaintext secrets left in localStorage by older
 * builds into the keychain and removes them, so nothing sensitive is persisted
 * in clear text anymore.
 *
 * One-time migration: on the first launch after this single-vault change, any
 * legacy per-key keychain entries are folded into the vault and deleted.
 */
export async function hydrateSecrets(): Promise<void> {
  const vault = await vaultLoad();
  // If the vault already exists, skip the legacy per-key reads entirely —
  // those entries were migrated away, and reading them would only cost IPC.
  const vaultSeeded = Object.keys(vault).length > 0;

  for (const key of SECRET_KEYS) {
    if (!vaultSeeded) {
      const legacyEntry = await secureGet(key);
      if (legacyEntry != null) {
        vault[key] = legacyEntry;
        await secureDelete(key).catch(() => undefined);
      }
    }

    if (typeof window !== "undefined") {
      const legacy = window.localStorage.getItem(key);
      if (legacy) {
        if (vault[key] == null) vault[key] = legacy;
        window.localStorage.removeItem(key);
      }
    }

    if (vault[key] != null) secretCache.set(key, vault[key]);
  }

  if (Object.keys(vault).length > 0) await vaultPersist(vault);
}

/**
 * Re-read a secret from the OS keychain into the in-memory cache and return
 * it. Used at connection time so a key changed in the Keychain takes effect
 * immediately without restarting the app (the startup hydration only runs
 * once and would otherwise keep serving a stale value).
 */
export async function refreshSecret(account: string): Promise<string | null> {
  const vault = await vaultLoad();
  const value = vault[account] ?? null;
  if (value != null) secretCache.set(account, value);
  return value;
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
    persistCacheAsVault();
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
  },
  removeItem(key: string): void {
    if (!SECRET_KEYS.has(key)) {
      if (typeof window !== "undefined") window.localStorage.removeItem(key);
      return;
    }
    secretCache.delete(key);
    persistCacheAsVault();
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
  },
};
