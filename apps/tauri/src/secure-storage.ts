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
  "lynse_live_translation_tencent_secret_key",
  "lynse_feishu_app_secret",
]);

/**
 * All secrets are stored under ONE keychain entry (a JSON map) instead of one
 * entry per key. macOS shows an authorization prompt per keychain item for an
 * untrusted binary, so the old per-key layout asked for the password several
 * times on every launch; a single vault means at most one prompt.
 */
const VAULT_ACCOUNT = "lynse_secrets_v1";

const secretCache = new Map<string, string>();

/**
 * Read one raw entry. Absence resolves to null; a keychain failure (locked
 * keychain, ACL denial, IPC error) REJECTS. Swallowing failures into null
 * used to make an unreadable vault indistinguishable from an empty one, which
 * corrupted the vault on writes and silently served stale cached keys to the
 * providers — the "saved the key but still get 401" class of bugs.
 */
async function secureGet(account: string): Promise<string | null> {
  return await invoke<string | null>("secure_get_secret", { account });
}

async function secureSet(account: string, value: string): Promise<void> {
  await invoke("secure_set_secret", { account, value });
}

async function secureDelete(account: string): Promise<void> {
  await invoke("secure_delete_secret", { account });
}

/**
 * Atomically set (`value`) or remove (`null`) one entry inside the vault.
 * The read-modify-write runs in Rust under a process-wide lock, so writes
 * from different webview windows (main window config panel, recording island
 * refreshing the auth token) can no longer overwrite each other — a window's
 * promise chain only orders its own writes.
 */
async function vaultUpdateEntry(account: string, value: string | null): Promise<void> {
  await invoke("secure_update_vault_entry", { account, value });
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

async function vaultPersist(map: Record<string, string>): Promise<void> {
  const keys = Object.keys(map);
  if (keys.length === 0) {
    await secureDelete(VAULT_ACCOUNT);
    return;
  }
  await secureSet(VAULT_ACCOUNT, JSON.stringify(map));
}

/**
 * Serialized read-modify-write of the keychain vault, for multi-key mutations.
 * Every mutation goes through this promise chain so concurrent calls can't
 * interleave within this window, and each write reloads the vault from the
 * keychain first instead of trusting the in-memory cache. A vault READ failure
 * rejects the mutation — persisting a map built on an empty read would wipe
 * every secret not in that read. Single-entry mutations should prefer
 * `vaultUpdateEntry`, which serializes across ALL windows in Rust.
 *
 * The mutator returns whether it actually changed anything. A no-op mutation
 * skips the write entirely, because persisting an unchanged vault would touch
 * the keychain on every launch and re-trigger macOS' authorization prompt.
 */
let vaultWriteChain: Promise<void> = Promise.resolve();
function vaultMutate(mutator: (vault: Record<string, string>) => boolean): Promise<void> {
  const run = vaultWriteChain.then(async () => {
    const vault = await vaultLoad();
    // Await the keychain write itself so the promise resolves only once the
    // vault is durable — callers that surface failures to the user (config
    // saves) must not be told "saved" while the IPC write is still in flight
    // or has already failed.
    if (mutator(vault)) await vaultPersist(vault);
  });
  // Keep the chain alive even if a write rejects, so later writes still run.
  vaultWriteChain = run.catch(() => undefined);
  return run;
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
  // An unreadable vault must abort hydration before any write: continuing on
  // an empty read would migrate legacy entries into a vault that overwrites
  // and destroys whatever the keychain failed to hand back.
  let vault: Record<string, string>;
  try {
    vault = await vaultLoad();
  } catch (error) {
    console.error("[secure-storage] keychain vault unreadable, skipping hydration", error);
    return;
  }
  // If the vault already exists, skip the legacy per-key reads entirely —
  // those entries were migrated away, and reading them would only cost IPC.
  const vaultSeeded = Object.keys(vault).length > 0;
  let changed = false;

  for (const key of SECRET_KEYS) {
    if (!vaultSeeded) {
      const legacyEntry = await secureGet(key).catch(() => null);
      if (legacyEntry != null) {
        vault[key] = legacyEntry;
        changed = true;
        await secureDelete(key).catch(() => undefined);
      }
    }

    if (typeof window !== "undefined") {
      const legacy = window.localStorage.getItem(key);
      if (legacy) {
        if (vault[key] == null) {
          vault[key] = legacy;
          changed = true;
        }
        window.localStorage.removeItem(key);
      }
    }

    if (vault[key] != null) secretCache.set(key, vault[key]);
  }

  if (changed) {
    await vaultMutate((existing) => {
      let dirty = false;
      for (const [k, value] of Object.entries(vault)) {
        if (existing[k] !== value) {
          existing[k] = value;
          dirty = true;
        }
      }
      return dirty;
    });
  }
}

/**
 * Re-read a secret from the OS keychain into the in-memory cache and return
 * it. Used at connection time so a key changed in the Keychain takes effect
 * immediately without restarting the app (the startup hydration only runs
 * once and would otherwise keep serving a stale value).
 *
 * Read failures REJECT rather than falling back to the cache: handing a
 * caller the stale cached credential after a keychain failure is exactly how
 * a correct-looking config produced provider 401s with no visible cause. The
 * error is logged first so it lands in the same file as the rest of the
 * session's diagnostics.
 */
export async function refreshSecret(account: string): Promise<string | null> {
  let value: string | null;
  try {
    const vault = await vaultLoad();
    value = vault[account] ?? null;
  } catch (error) {
    console.error(`[secure-storage] failed to re-read ${account} from the keychain`, error);
    throw error;
  }
  if (value != null) secretCache.set(account, value);
  return value;
}

/**
 * Persist (or clear) one secret and resolve only after the keychain write has
 * actually landed — or reject with the underlying error.
 *
 * The synchronous `StorageAdapter.setItem` can't surface keychain failures
 * (its fire-and-forget persistence is the right trade-off for the auth token),
 * but configuration forms must know whether the save really happened before
 * telling the user it did. A swallowed write failure here meant the settings
 * panel claimed success while the recording start re-read the OLD key from
 * the vault and got a 401 from the provider.
 */
export async function setSecret(key: string, value: string): Promise<void> {
  if (!SECRET_KEYS.has(key)) {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value);
    return;
  }
  secretCache.set(key, value);
  await vaultUpdateEntry(key, value);
  if (typeof window !== "undefined") window.localStorage.removeItem(key);
}

export async function removeSecret(key: string): Promise<void> {
  if (!SECRET_KEYS.has(key)) {
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
    return;
  }
  secretCache.delete(key);
  await vaultUpdateEntry(key, null);
  if (typeof window !== "undefined") window.localStorage.removeItem(key);
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
    vaultUpdateEntry(key, value).catch((error) =>
      console.error(`[secure-storage] failed to persist ${key}`, error),
    );
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
  },
  removeItem(key: string): void {
    if (!SECRET_KEYS.has(key)) {
      if (typeof window !== "undefined") window.localStorage.removeItem(key);
      return;
    }
    secretCache.delete(key);
    vaultUpdateEntry(key, null).catch((error) =>
      console.error(`[secure-storage] failed to remove ${key}`, error),
    );
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
  },
};

/** Credential keys that must not outlive a logout. */
const AUTH_SECRET_KEYS = ["lynse_api_key", "lynse_token"] as const;

/**
 * Wipe the login credentials from the OS keychain (plus the in-memory cache
 * and any legacy plaintext copies). Called on logout: the keychain must not
 * outlive the session. Idempotent — every step is a no-op when already gone.
 * Note the vault write is an async IPC: quitting the app within the following
 * few hundred ms could still land the delete on the next launch's hydration.
 */
export async function clearAuthSecrets(): Promise<void> {
  for (const key of AUTH_SECRET_KEYS) {
    secretCache.delete(key);
    if (typeof window !== "undefined") window.localStorage.removeItem(key);
  }
  await vaultMutate((vault) => {
    let dirty = false;
    for (const key of AUTH_SECRET_KEYS) {
      if (key in vault) {
        delete vault[key];
        dirty = true;
      }
    }
    return dirty;
  });
}
