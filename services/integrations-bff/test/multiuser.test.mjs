/**
 * Multiuser end-to-end tests (plan step 11 offline matrix): concurrent
 * authorization isolation, multi-account + reconnect, cross-user denial,
 * expiry, restart recovery, read whitelist and connection pinning. Runs the
 * real handler against fake gateway/identity HTTP servers.
 *
 * Env must be set before importing src/ modules (config is load-time).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CONNECTORS_MULTIUSER = "1";
process.env.CONNECTORS_PROVIDERS = "google_calendar,google_tasks,notion";
process.env.ADMIN_TOKEN = "test-admin-token";

const { fakeGateway, fakeIdentity, listen, closeServer } = await import("./helpers.mjs");
const { Store } = await import("../src/store.mjs");
const { createStoreBoundHandler } = await import("../src/routes.mjs");

const gateway = fakeGateway({
  connections: [],
  onAction: (entry) => {
    // Every read action must arrive with a minted scoped token, not the
    // shared runtime token (whose value the BFF keeps to itself here).
    assert.ok(
      entry.authorization.startsWith("Bearer oct-test-"),
      `action ${entry.actionId} must use a minted scoped runtime token`,
    );
    return { ok: true };
  },
});
const identity = fakeIdentity({ tokens: { "tok-A": "user-A", "tok-B": "user-B" } });

const gwPort = await listen(gateway.server);
const idPort = await listen(identity.server);
process.env.GW = `http://127.0.0.1:${gwPort}`;
process.env.IDENTITY_URL = `http://127.0.0.1:${idPort}`;

const dbDir = mkdtempSync(join(tmpdir(), "bff-e2e-"));
const dbFile = join(dbDir, "registry.sqlite3");
const store = new Store(dbFile);
const handler = createStoreBoundHandler(store);
const bff = createServer((req, res) => handler(req, res));
const bffPort = await listen(bff);
const base = `http://127.0.0.1:${bffPort}`;

async function call(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/** Simulate the gateway's OAuth callback landing: a connection appears whose
 *  alias equals the connectionName the BFF sent. */
function completeOnGateway(authorizeBody, connectionId, extra = {}) {
  gateway.connections.push({
    id: connectionId,
    service: authorizeBody.service,
    configured: true,
    virtual: false,
    connectionName: authorizeBody.connectionName,
    oauthAuthorizationId: `up-${authorizeBody.connectionName}`,
    profile: { displayName: extra.displayName ?? connectionId },
  });
}

test("unauthenticated and foreign-token requests are rejected", async () => {
  const noToken = await call("/api/v2/integrations/google-calendar/status");
  assert.equal(noToken.status, 401);
  const gatewayKey = await call("/api/v2/integrations/google-calendar/status", { token: "gw-admin-key" });
  assert.equal(gatewayKey.status, 401, "a gateway key is not a Lynse identity");
  const badToken = await call("/api/v2/integrations/google-calendar/status", { token: "bogus" });
  assert.equal(badToken.status, 401);
});

test("concurrent authorizations bind to their own user only", async () => {
  const beginA = await call("/api/v2/integrations/google-calendar/oauth-state", {
    method: "POST", token: "tok-A", body: { provider: "google_calendar" },
  });
  assert.equal(beginA.status, 200);
  const beginB = await call("/api/v2/integrations/google-calendar/oauth-state", {
    method: "POST", token: "tok-B", body: { provider: "google_calendar" },
  });
  const authorizeA = gateway.seen.authorizations.at(-2);
  const authorizeB = gateway.seen.authorizations.at(-1);
  assert.notEqual(authorizeA.connectionName, authorizeB.connectionName, "per-request aliases differ");
  assert.equal(authorizeA.service, "googlecalendar");

  // Both providers complete "simultaneously" before either polls.
  completeOnGateway(authorizeA, "conn-A", { displayName: "a@gmail.com" });
  completeOnGateway(authorizeB, "conn-B", { displayName: "b@gmail.com" });

  const pollA = await call(`/api/v2/integrations/oauth/result/${beginA.json.authorization_request_id}`, { token: "tok-A" });
  assert.equal(pollA.json.status, "done");
  assert.equal(pollA.json.account_id, pollA.json.account.id);
  const pollB = await call(`/api/v2/integrations/oauth/result/${beginB.json.authorization_request_id}`, { token: "tok-B" });
  assert.equal(pollB.json.status, "done");

  const statusA = await call("/api/v2/integrations/google-calendar/status", { token: "tok-A" });
  assert.equal(statusA.json.accounts.length, 1, "A sees exactly one account");
  const statusB = await call("/api/v2/integrations/google-calendar/status", { token: "tok-B" });
  assert.equal(statusB.json.accounts.length, 1);
  assert.notEqual(statusA.json.accounts[0].id, statusB.json.accounts[0].id);

  // Cross-user queries of a request id are indistinguishable from missing.
  const crossPoll = await call(`/api/v2/integrations/oauth/result/${beginA.json.authorization_request_id}`, { token: "tok-B" });
  assert.equal(crossPoll.status, 404);
  // Repeat polls stay consistent (done results survive at least 24h).
  const repoll = await call(`/api/v2/integrations/oauth/result/${beginA.json.authorization_request_id}`, { token: "tok-A" });
  assert.equal(repoll.json.status, "done");
  assert.equal(repoll.json.account_id, pollA.json.account_id);
});

test("one user can connect two accounts and reads pin the chosen one", async () => {
  const begin = await call("/api/v2/integrations/google-calendar/oauth-state", {
    method: "POST", token: "tok-A", body: { provider: "google_calendar" },
  });
  const authorize = gateway.seen.authorizations.at(-1);
  completeOnGateway(authorize, "conn-A2", { displayName: "second@gmail.com" });
  const done = await call(`/api/v2/integrations/oauth/result/${begin.json.authorization_request_id}`, { token: "tok-A" });
  assert.equal(done.json.status, "done");
  const secondAccount = done.json.account_id;

  const selection = await call("/api/v2/integrations/google_calendar/read", {
    method: "POST", token: "tok-A",
    body: { operation: "list_events", arguments: { time_min: "2026-10-09T00:00:00+08:00", time_max: "2026-10-10T00:00:00+08:00" } },
  });
  assert.equal(selection.status, 200);
  assert.equal(selection.json.status, "account_selection_required", "ambiguous intent must ask, not pick silently");
  assert.equal(selection.json.accounts.length, 2);

  gateway.seen.actions.length = 0;
  const read = await call("/api/v2/integrations/google_calendar/read", {
    method: "POST", token: "tok-A",
    body: {
      operation: "list_events",
      account_id: secondAccount,
      arguments: { time_min: "2026-10-09T00:00:00+08:00", time_max: "2026-10-10T00:00:00+08:00" },
    },
  });
  assert.equal(read.json.status, "ok");
  // The account's connection_id is internal; verify pinning via the minted
  // runtime token's policy captured by the fake gateway.
  const owned = store.accountsFor("user-A", "google-calendar").find((a) => a.id === secondAccount);
  const mint = gateway.seen.tokenMints.find(
    (m) => JSON.stringify(m.policy?.allowedConnections) === JSON.stringify([owned.connection_id]),
  );
  assert.ok(mint, "a runtime token must be minted for the chosen connection");
  assert.deepEqual(mint.policy.allowedConnections, [owned.connection_id]);
  assert.deepEqual(
    mint.policy.allowedActions,
    ["googlecalendar.list_events_all_calendars"],
    "read tokens are pinned to the single whitelisted action",
  );
});

test("reads and disconnects cannot touch another user's account", async () => {
  const statusB = await call("/api/v2/integrations/google-calendar/status", { token: "tok-B" });
  const bAccount = statusB.json.accounts[0].id;
  const foreign = await call("/api/v2/integrations/google_calendar/read", {
    method: "POST", token: "tok-A", body: { operation: "list_calendars", account_id: bAccount },
  });
  assert.equal(foreign.status, 404, "A cannot read B's account");
  const foreignDisconnect = await call(`/api/v2/integrations/google-calendar/disconnect?account_id=${bAccount}`, { method: "DELETE", token: "tok-A" });
  assert.equal(foreignDisconnect.status, 404, "A cannot disconnect B's account");
  const stillThere = await call("/api/v2/integrations/google-calendar/status", { token: "tok-B" });
  assert.equal(stillThere.json.accounts.length, 1);
});

test("reconnect keeps the product account id and a late old poll cannot rebind", async () => {
  const begin = await call("/api/v2/integrations/google-tasks/oauth-state", {
    method: "POST", token: "tok-A", body: { provider: "google_tasks" },
  });
  const firstAuth = gateway.seen.authorizations.at(-1);
  completeOnGateway(firstAuth, "conn-tasks-1", { displayName: "tasks@gmail.com" });
  const done = await call(`/api/v2/integrations/oauth/result/${begin.json.authorization_request_id}`, { token: "tok-A" });
  const accountId = done.json.account_id;

  // Reconnect: same target account, new alias.
  const rebegin = await call("/api/v2/integrations/google-tasks/oauth-state", {
    method: "POST", token: "tok-A", body: { provider: "google_tasks", account_id: accountId },
  });
  const reAuth = gateway.seen.authorizations.at(-1);
  completeOnGateway(reAuth, "conn-tasks-2", { displayName: "tasks@gmail.com" });
  const redone = await call(`/api/v2/integrations/oauth/result/${rebegin.json.authorization_request_id}`, { token: "tok-A" });
  assert.equal(redone.json.status, "done");
  assert.equal(redone.json.account_id, accountId, "product id stable across reconnect");

  // The FIRST request stays done with its original binding — polling it again
  // must not flip the account back to the old connection.
  const late = await call(`/api/v2/integrations/oauth/result/${begin.json.authorization_request_id}`, { token: "tok-A" });
  assert.equal(late.json.status, "done");
  assert.equal(late.json.account_id, accountId);
  const rebound = store.accountById("user-A", accountId);
  assert.equal(rebound.connection_id, "conn-tasks-2");
});

test("registry rejects non-whitelisted operations and arguments", async () => {
  const writeAttempt = await call("/api/v2/integrations/google_calendar/read", {
    method: "POST", token: "tok-A", body: { operation: "delete_event", arguments: {} },
  });
  assert.equal(writeAttempt.status, 400);
  const injection = await call("/api/v2/integrations/notion/read", {
    method: "POST", token: "tok-A", body: { operation: "read_page", arguments: { page_id: "p", token: "leak" } },
  });
  assert.equal(injection.status, 400);
  const missing = await call("/api/v2/integrations/notion/read", {
    method: "POST", token: "tok-A", body: { operation: "read_page", arguments: {} },
  });
  assert.equal(missing.status, 400);
  const connectionRequired = await call("/api/v2/integrations/outlook_calendar/read", {
    method: "POST", token: "tok-A", body: { operation: "list_events", arguments: {} },
  });
  assert.equal(connectionRequired.status, 400, "providers outside the first batch stay closed");
});

test("connection_required comes back before any account exists", async () => {
  const read = await call("/api/v2/integrations/notion/read", {
    method: "POST", token: "tok-B", body: { operation: "search", arguments: { query: "roadmap" } },
  });
  assert.equal(read.status, 200);
  assert.equal(read.json.status, "connection_required");
});

test("expired authorization requests answer expired, not pending forever", async () => {
  const begin = await call("/api/v2/integrations/notion/oauth-state", {
    method: "POST", token: "tok-B", body: { provider: "notion" },
  });
  const request = store.authorizationRequestById(begin.json.authorization_request_id);
  store.purgeStaleAuthorizationRequests(request.expires_at + 1);
  const poll = await call(`/api/v2/integrations/oauth/result/${begin.json.authorization_request_id}`, { token: "tok-B" });
  assert.equal(poll.json.status, "expired");
  // Legacy desktop shape maps expiry onto the error channel.
  const legacy = await call(`/api/v2/integrations/notion/oauth-result?state=${begin.json.authorization_request_id}`, { token: "tok-B" });
  assert.equal(legacy.json.status, "error");
});

test("state survives a restart (store reopened from disk)", async () => {
  const statusA = await call("/api/v2/integrations/google-calendar/status", { token: "tok-A" });
  const before = statusA.json.accounts;
  assert.ok(before.length >= 2);
  const reopened = new Store(dbFile);
  const accounts = reopened.accountsFor("user-A", "google-calendar");
  assert.deepEqual(accounts.map((a) => a.id).sort(), before.map((a) => a.id).sort());
  reopened.close();
});

test("disconnect removes exactly the selected connection", async () => {
  const statusB = await call("/api/v2/integrations/google-calendar/status", { token: "tok-B" });
  const accountId = statusB.json.accounts[0].id;
  const owned = store.accountById("user-B", accountId);
  const gone = await call(`/api/v2/integrations/google-calendar/disconnect?account_id=${accountId}`, { method: "DELETE", token: "tok-B" });
  assert.equal(gone.json.connected, false);
  assert.deepEqual(gateway.seen.deletes.at(-1), { service: "googlecalendar", connectionId: owned.connection_id });
  const after = await call("/api/v2/integrations/google-calendar/status", { token: "tok-A" });
  assert.equal(after.json.accounts.length, 2, "another user's accounts are untouched");
});

test("calendar events only merge the caller's accounts", async () => {
  // B owns zero calendar rows after the disconnect; A owns two.
  const events = await call("/api/v2/calendar/events?from=2026-10-01T00:00:00Z&to=2026-10-30T00:00:00Z", { token: "tok-B" });
  assert.equal(events.json.connected, false);
});

test.after(async () => {
  await closeServer(bff);
  await closeServer(gateway.server);
  await closeServer(identity.server);
  store.close();
});
