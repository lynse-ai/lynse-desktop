/**
 * BFF configuration. Everything comes from the environment; nothing is
 * request-controlled (plan step 2.4: the identity URL is server-pinned).
 *
 * Fields are lazy getters — the environment is read at call time, so tests
 * can point the gateway/identity at their stub servers regardless of import
 * order.
 *
 * `CONNECTORS_MULTIUSER=1` switches the whole service onto the per-principal
 * registry: every endpoint then requires a verified Lynse token. The default
 * keeps the legacy shared-account debug behaviour untouched, so the flag flip
 * is a deliberate rollout step (plan step 12.3), not an accident.
 */

function num(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function flag(name) {
  return ["1", "true", "yes"].includes((process.env[name] ?? "").trim().toLowerCase());
}

export const config = {
  get port() {
    return num("PORT", 3101);
  },
  get host() {
    return process.env.HOST ?? "0.0.0.0";
  },
  get gw() {
    return (process.env.GW ?? "http://127.0.0.1:3100/oc").replace(/\/+$/, "");
  },
  get adminToken() {
    return process.env.ADMIN_TOKEN ?? "";
  },
  get runtimeToken() {
    return process.env.RUNTIME_TOKEN ?? process.env.ADMIN_TOKEN ?? "";
  },
  get legacyStateFile() {
    return process.env.STATE_FILE ?? "/data/state.json";
  },

  get multiuser() {
    return flag("CONNECTORS_MULTIUSER");
  },
  get dbFile() {
    return process.env.CONNECTORS_DB_FILE ?? "/data/connectors.sqlite3";
  },
  /** lynclaw `GET /api/connectors/identity` — the only identity authority. */
  get identityUrl() {
    return (process.env.IDENTITY_URL ?? "").replace(/\/+$/, "");
  },
  get identityTimeoutMs() {
    return num("IDENTITY_TIMEOUT_MS", 10_000);
  },
  get identityCacheTtlMs() {
    return num("IDENTITY_CACHE_TTL_MS", 300_000);
  },
  get identityCacheMax() {
    return num("IDENTITY_CACHE_MAX", 4096);
  },

  /** Authorization requests TTL (plan step 5.6: 10 minutes). */
  get authTtlMs() {
    return Math.max(60_000, num("CONNECTORS_AUTH_TTL_MS", 600_000));
  },
  /** Completed results stay answerable for at least 24h (plan step 5.6). */
  get resultRetentionMs() {
    return Math.max(24 * 3_600_000, num("CONNECTORS_RESULT_RETENTION_MS", 7 * 24 * 3_600_000));
  },

  /**
   * Connection pinning mints per-(connection, action) runtime tokens via the
   * admin API (`allowedConnections` policy) — no extra shared secret is
   * needed, the BFF's ADMIN_TOKEN authorizes minting. Without ADMIN_TOKEN the
   * read path fails closed once a service has more than one connection — it
   * never silently executes against the wrong account.
   */
  get providersEnabled() {
    return (process.env.CONNECTORS_PROVIDERS ?? "google_calendar,google_tasks,notion")
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  },
};

/** Contract provider (kebab) ↔ lynclaw provider (snake) aliases. */
export function normalizeProvider(provider) {
  return String(provider ?? "").trim().toLowerCase().replace(/_/g, "-");
}

export function lynclawProviderName(provider) {
  return normalizeProvider(provider).replace(/-/g, "_");
}
