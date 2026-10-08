/**
 * Per-principal registry (plan step 3): accounts, authorization requests,
 * summary docs and the feishu self-serve app live in a transactional SQLite
 * database (node:sqlite, WAL) instead of one shared JSON file. First phase is
 * a single BFF process — DatabaseSync is synchronous and guarded by this
 * module; multi-instance deployments need a real lock story first (README).
 *
 * Ownership model: every row carries `principal` (the verified Lynse user id)
 * and every read/write goes through a principal-scoped accessor, so account
 * ids alone are location references, not capabilities (plan: request_id 只作
 * 定位，不能替代鉴权).
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomId } from "./http.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  provider TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  connection_name TEXT,
  email TEXT,
  display_name TEXT,
  workspace_name TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0,
  sync_enabled INTEGER NOT NULL DEFAULT 1,
  notify_enabled INTEGER NOT NULL DEFAULT 1,
  auto_export INTEGER NOT NULL DEFAULT 0,
  default_destination_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_unique
  ON accounts (principal, provider, connection_id);
CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts (principal, provider);

CREATE TABLE IF NOT EXISTS authorization_requests (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  provider TEXT NOT NULL,
  service TEXT NOT NULL,
  connection_name TEXT NOT NULL,
  oauth_authorization_id TEXT,
  target_account_id TEXT,
  status TEXT NOT NULL,           -- pending | done | expired | superseded | error
  status_detail TEXT,
  account_id TEXT,                -- set on completion (product account id)
  result_json TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_authreq_pending
  ON authorization_requests (principal, provider, status);

CREATE TABLE IF NOT EXISTS summary_docs (
  principal TEXT NOT NULL,
  file_id TEXT NOT NULL,
  file_token TEXT NOT NULL,
  url TEXT NOT NULL,
  file_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (principal, file_id)
);

CREATE TABLE IF NOT EXISTS feishu_apps (
  principal TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export class Store {
  /** @type {import("node:sqlite").DatabaseSync} */
  #db;

  constructor(dbFile) {
    if (dbFile !== ":memory:") mkdirSync(dirname(dbFile), { recursive: true });
    this.#db = new DatabaseSync(dbFile);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(SCHEMA);
  }

  close() {
    this.#db.close();
  }

  /** Synchronous transaction; rolls back on throw. */
  #tx(fn) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  // -- accounts -----------------------------------------------------------

  createAccount({ principal, provider, connectionId, connectionName, email, displayName, workspaceName, now = Date.now() }) {
    return this.#tx(() => {
      const existing = this.#db
        .prepare("SELECT * FROM accounts WHERE principal = ? AND provider = ? AND connection_id = ?")
        .get(principal, provider, connectionId);
      if (existing) return this.#accountRow(existing);
      const hasPrimary = this.#db
        .prepare("SELECT 1 FROM accounts WHERE principal = ? AND provider = ? AND is_primary = 1")
        .get(principal, provider);
      const id = `acct-${provider}-${randomId()}`;
      this.#db
        .prepare(
          `INSERT INTO accounts (id, principal, provider, connection_id, connection_name, email, display_name,
             workspace_name, is_primary, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id, principal, provider, connectionId, connectionName ?? null, email ?? null,
          displayName ?? null, workspaceName ?? null, hasPrimary ? 0 : 1, now, now,
        );
      return this.accountById(principal, id);
    });
  }

  #accountRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      principal: row.principal,
      provider: row.provider,
      connection_id: row.connection_id,
      connection_name: row.connection_name,
      email: row.email,
      display_name: row.display_name,
      workspace_name: row.workspace_name ?? undefined,
      is_primary: Boolean(row.is_primary),
      sync_enabled: Boolean(row.sync_enabled),
      notify_enabled: Boolean(row.notify_enabled),
      auto_export: Boolean(row.auto_export),
      default_destination_id: row.default_destination_id ?? null,
      created_at: row.created_at,
    };
  }

  accountById(principal, id) {
    const row = this.#db.prepare("SELECT * FROM accounts WHERE principal = ? AND id = ?").get(principal, id);
    return this.#accountRow(row);
  }

  accountsFor(principal, provider) {
    const rows = provider
      ? this.#db.prepare("SELECT * FROM accounts WHERE principal = ? AND provider = ? ORDER BY created_at").all(principal, provider)
      : this.#db.prepare("SELECT * FROM accounts WHERE principal = ? ORDER BY provider, created_at").all(principal);
    return rows.map((row) => this.#accountRow(row));
  }

  /** Atomic reconnect switch (plan step 5.4): same product id, new connection. */
  rebindAccount(principal, accountId, { connectionId, connectionName, now = Date.now() }) {
    return this.#tx(() => {
      const account = this.accountById(principal, accountId);
      if (!account) return null;
      this.#db
        .prepare("UPDATE accounts SET connection_id = ?, connection_name = ?, updated_at = ? WHERE principal = ? AND id = ?")
        .run(connectionId, connectionName ?? null, now, principal, accountId);
      return this.accountById(principal, accountId);
    });
  }

  deleteAccount(principal, accountId) {
    this.#tx(() => {
      const account = this.accountById(principal, accountId);
      if (!account) return;
      this.#db.prepare("DELETE FROM accounts WHERE principal = ? AND id = ?").run(principal, accountId);
      if (account.is_primary) {
        const next = this.#db
          .prepare("SELECT id FROM accounts WHERE principal = ? AND provider = ? ORDER BY created_at LIMIT 1")
          .get(principal, account.provider);
        if (next) {
          this.#db.prepare("UPDATE accounts SET is_primary = 1 WHERE principal = ? AND id = ?").run(principal, next.id);
        }
      }
    });
  }

  updateAccountSettings(principal, accountId, patch, { now = Date.now() } = {}) {
    return this.#tx(() => {
      const account = this.accountById(principal, accountId);
      if (!account) return null;
      const sets = [];
      const values = [];
      for (const key of ["sync_enabled", "notify_enabled", "auto_export"]) {
        if (typeof patch[key] === "boolean") {
          sets.push(`${key} = ?`);
          values.push(patch[key] ? 1 : 0);
        }
      }
      if (patch.default_destination_id !== undefined) {
        sets.push("default_destination_id = ?");
        values.push(patch.default_destination_id);
      }
      if (sets.length) {
        sets.push("updated_at = ?");
        values.push(now, principal, accountId);
        this.#db
          .prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE principal = ? AND id = ?`)
          .run(...values);
      }
      return this.accountById(principal, accountId);
    });
  }

  // -- authorization requests ----------------------------------------------

  createAuthorizationRequest({ principal, provider, service, targetAccountId = null, now = Date.now(), ttlMs }) {
    const id = randomId("authreq-");
    const connectionName = `lynse-${id}`; // per-request alias (plan step 5.1)
    this.#db
      .prepare(
        `INSERT INTO authorization_requests
           (id, principal, provider, service, connection_name, target_account_id, status, created_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(id, principal, provider, service, connectionName, targetAccountId, now, now + ttlMs, now);
    return this.authorizationRequestById(id);
  }

  #requestRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      principal: row.principal,
      provider: row.provider,
      service: row.service,
      connection_name: row.connection_name,
      oauth_authorization_id: row.oauth_authorization_id,
      target_account_id: row.target_account_id,
      status: row.status,
      status_detail: row.status_detail,
      account_id: row.account_id,
      result: row.result_json ? JSON.parse(row.result_json) : null,
      created_at: row.created_at,
      expires_at: row.expires_at,
    };
  }

  authorizationRequestById(id, principal = undefined) {
    const row =
      principal === undefined
        ? this.#db.prepare("SELECT * FROM authorization_requests WHERE id = ?").get(id)
        : this.#db.prepare("SELECT * FROM authorization_requests WHERE id = ? AND principal = ?").get(id, principal);
    return this.#requestRow(row);
  }

  /**
   * A new pending request for the same (principal, provider, target account)
   * invalidates older ones (plan step 5.5) — but different users, or
   * different target accounts, never replace each other.
   */
  supersedePendingRequests(principal, provider, targetAccountId, exceptId, now = Date.now()) {
    return this.#tx(() => {
      const rows = this.#db
        .prepare(
          "SELECT id FROM authorization_requests WHERE principal = ? AND provider = ? AND status = 'pending' AND id != ?",
        )
        .all(principal, provider, exceptId);
      for (const row of rows) {
        const existing = this.authorizationRequestById(row.id);
        const sameTarget = (existing.target_account_id ?? null) === (targetAccountId ?? null);
        const bothNewAccount = existing.target_account_id === null && targetAccountId === null;
        if (!sameTarget && !bothNewAccount) continue;
        this.#db
          .prepare("UPDATE authorization_requests SET status = 'superseded', status_detail = 'replaced_by_new_request', updated_at = ? WHERE id = ?")
          .run(now, row.id);
      }
    });
  }

  setAuthorizationUpstream(id, { oauthAuthorizationId }) {
    this.#db
      .prepare("UPDATE authorization_requests SET oauth_authorization_id = ?, updated_at = ? WHERE id = ?")
      .run(oauthAuthorizationId ?? null, Date.now(), id);
  }

  #completeAuthorization(row, { accountId, result }, now) {
    return this.#tx(() => {
      const fresh = this.authorizationRequestById(row.id);
      if (fresh.status !== "pending") return fresh; // lost a race; result stays consistent
      this.#db
        .prepare(
          "UPDATE authorization_requests SET status = 'done', account_id = ?, result_json = ?, updated_at = ? WHERE id = ?",
        )
        .run(accountId, JSON.stringify(result ?? {}), now, row.id);
      return this.authorizationRequestById(row.id);
    });
  }

  failAuthorizationRequest(id, detail, now = Date.now()) {
    this.#db
      .prepare("UPDATE authorization_requests SET status = 'error', status_detail = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(detail, now, id);
  }

  expireAuthorizationRequest(id, detail, now = Date.now()) {
    this.#db
      .prepare("UPDATE authorization_requests SET status = 'expired', status_detail = ?, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(detail, now, id);
  }

  /**
   * Completion path (plan step 5.3): only a connection whose gateway alias
   * AND upstream authorization id both match this request may bind an
   * account, and the binding is one transaction.
   */
  completeAuthorizationRequest(id, { connectionId, connectionName, oauthAuthorizationId, accountFields }, now = Date.now()) {
    const row = this.authorizationRequestById(id);
    if (!row || row.status !== "pending") return { request: row, created: false };
    if (row.connection_name !== connectionName) return { request: row, created: false };
    if (row.oauth_authorization_id && oauthAuthorizationId && row.oauth_authorization_id !== oauthAuthorizationId) {
      return { request: row, created: false };
    }
    let account;
    let created = false;
    if (row.target_account_id) {
      account = this.rebindAccount(row.principal, row.target_account_id, {
        connectionId,
        connectionName,
        now,
      });
      if (!account) {
        account = this.createAccount({ principal: row.principal, provider: row.provider, connectionId, connectionName, ...accountFields, now });
        created = true;
      }
    } else {
      account = this.createAccount({ principal: row.principal, provider: row.provider, connectionId, connectionName, ...accountFields, now });
      created = true;
    }
    const request = this.#completeAuthorization(row, { accountId: account.id, result: { account_id: account.id } }, now);
    return { request, account, created };
  }

  /** Physically drop requests past their retention window (plan step 5.8). */
  purgeStaleAuthorizationRequests(now = Date.now()) {
    // Pending ones expire at their TTL; completed/superseded/error live out
    // the retention window so repeat polls keep answering consistently.
    this.#db
      .prepare("UPDATE authorization_requests SET status = 'expired', status_detail = 'ttl', updated_at = ? WHERE status = 'pending' AND expires_at < ?")
      .run(now, now);
    this.#db
      .prepare("DELETE FROM authorization_requests WHERE status != 'pending' AND updated_at < ?")
      .run(now - 30 * 24 * 3_600_000);
  }

  // -- summary docs / feishu app (principal-scoped) -------------------------

  getSummaryDoc(principal, fileId) {
    const row = this.#db
      .prepare("SELECT * FROM summary_docs WHERE principal = ? AND file_id = ?")
      .get(principal, fileId);
    return row ?? null;
  }

  setSummaryDoc(principal, fileId, { fileToken, url, fileName }, now = Date.now()) {
    this.#db
      .prepare(
        `INSERT INTO summary_docs (principal, file_id, file_token, url, file_name, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(principal, file_id) DO UPDATE SET file_token = excluded.file_token, url = excluded.url,
           file_name = excluded.file_name, updated_at = excluded.updated_at`,
      )
      .run(principal, fileId, fileToken, url, fileName, now);
  }

  getFeishuApp(principal) {
    const row = this.#db.prepare("SELECT * FROM feishu_apps WHERE principal = ?").get(principal);
    return row ?? null;
  }

  setFeishuApp(principal, { clientId, clientSecret }, now = Date.now()) {
    this.#db
      .prepare(
        `INSERT INTO feishu_apps (principal, client_id, client_secret, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(principal) DO UPDATE SET client_id = excluded.client_id,
           client_secret = excluded.client_secret, created_at = excluded.created_at`,
      )
      .run(principal, clientId, clientSecret, now);
  }
}
