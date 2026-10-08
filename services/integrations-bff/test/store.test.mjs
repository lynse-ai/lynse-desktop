/** Registry unit tests: ownership, idempotency, supersede, accurate binding. */

import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { Store } from "../src/store.mjs";

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "bff-store-"));
  return new Store(join(dir, "registry.sqlite3"));
}

test("accounts are owner-scoped and unique per connection", () => {
  const store = tempStore();
  const a = store.createAccount({ principal: "user-A", provider: "google-calendar", connectionId: "conn-1", email: "a@x", displayName: "A" });
  const again = store.createAccount({ principal: "user-A", provider: "google-calendar", connectionId: "conn-1", email: "a@x", displayName: "A" });
  assert.equal(again.id, a.id, "same principal+connection is idempotent");
  const b = store.createAccount({ principal: "user-B", provider: "google-calendar", connectionId: "conn-1", email: "a@x", displayName: "A" });
  assert.notEqual(b.id, a.id, "a shared gateway connection maps per principal");
  assert.equal(store.accountById("user-B", a.id), null, "cross-principal lookup is invisible");
  assert.equal(store.accountsFor("user-A", "google-calendar").length, 1);
});

test("rebind keeps the product account id stable", () => {
  const store = tempStore();
  const a = store.createAccount({ principal: "user-A", provider: "notion", connectionId: "conn-1" });
  const rebound = store.rebindAccount("user-A", a.id, { connectionId: "conn-2", connectionName: "lynse-x" });
  assert.equal(rebound.id, a.id);
  assert.equal(rebound.connection_id, "conn-2");
  assert.equal(store.rebindAccount("user-B", a.id, { connectionId: "conn-9" }), null);
});

test("supersede only within same principal/provider/target", () => {
  const store = tempStore();
  const base = { provider: "google-calendar", service: "googlecalendar" };
  const r1 = store.createAuthorizationRequest({ principal: "user-A", targetAccountId: null, ttlMs: 60_000, ...base });
  const r2 = store.createAuthorizationRequest({ principal: "user-A", targetAccountId: null, ttlMs: 60_000, ...base });
  store.supersedePendingRequests("user-A", "google-calendar", null, r2.id);
  assert.equal(store.authorizationRequestById(r1.id).status, "superseded");
  assert.equal(store.authorizationRequestById(r2.id).status, "pending");

  // A different target account is a different intent — not superseded.
  const acct = store.createAccount({ principal: "user-A", provider: "google-calendar", connectionId: "conn-1" });
  const r3 = store.createAuthorizationRequest({ principal: "user-A", targetAccountId: acct.id, ttlMs: 60_000, ...base });
  assert.equal(store.authorizationRequestById(r3.id).status, "pending");

  // Another user's new-account request never replaces A's.
  const rB = store.createAuthorizationRequest({ principal: "user-B", targetAccountId: null, ttlMs: 60_000, ...base });
  store.supersedePendingRequests("user-B", "google-calendar", null, rB.id);
  assert.equal(store.authorizationRequestById(r2.id).status, "pending");
});

test("completion requires the request alias and binds atomically", () => {
  const store = tempStore();
  const r = store.createAuthorizationRequest({
    principal: "user-A", provider: "google-calendar", service: "googlecalendar", targetAccountId: null, ttlMs: 60_000,
  });
  const wrongAlias = store.completeAuthorizationRequest(r.id, {
    connectionId: "conn-9", connectionName: "lynse-not-this-one", oauthAuthorizationId: "up-1", accountFields: {},
  });
  assert.equal(wrongAlias.request.status, "pending", "alias mismatch binds nothing");

  const ok = store.completeAuthorizationRequest(r.id, {
    connectionId: "conn-1", connectionName: r.connection_name, oauthAuthorizationId: r.oauth_authorization_id, accountFields: { displayName: "A" },
  });
  assert.equal(ok.request.status, "done");
  assert.equal(ok.account.principal, "user-A");
  // Repeat polls complete against the same request: consistent account.
  const repeat = store.completeAuthorizationRequest(r.id, {
    connectionId: "conn-1", connectionName: r.connection_name, oauthAuthorizationId: r.oauth_authorization_id, accountFields: {},
  });
  assert.equal(repeat.request.account_id, ok.account.id);
});

test("reconnect completion rebinds the target account id", () => {
  const store = tempStore();
  const original = store.createAccount({ principal: "user-A", provider: "google-tasks", connectionId: "conn-1" });
  const r = store.createAuthorizationRequest({
    principal: "user-A", provider: "google-tasks", service: "googletasks", targetAccountId: original.id, ttlMs: 60_000,
  });
  const outcome = store.completeAuthorizationRequest(r.id, {
    connectionId: "conn-2", connectionName: r.connection_name, oauthAuthorizationId: null, accountFields: {},
  });
  assert.equal(outcome.account.id, original.id, "product id stable across reconnect");
  assert.equal(outcome.account.connection_id, "conn-2");
  assert.equal(outcome.created, false);
});

test("expiry flips pending requests and purge drops old results", () => {
  const store = tempStore();
  const now = Date.now();
  const r = store.createAuthorizationRequest({ principal: "user-A", provider: "notion", service: "notion", targetAccountId: null, ttlMs: 1_000, now });
  store.purgeStaleAuthorizationRequests(now + 2_000);
  assert.equal(store.authorizationRequestById(r.id).status, "expired");
  store.purgeStaleAuthorizationRequests(now + 31 * 24 * 3_600_000);
  assert.equal(store.authorizationRequestById(r.id), null, "past retention the row is gone");
});

test("summary docs and feishu apps are principal-scoped", () => {
  const store = tempStore();
  store.setSummaryDoc("user-A", "file-1", { fileToken: "tok", url: "u", fileName: "n" });
  assert.equal(store.getSummaryDoc("user-B", "file-1"), null);
  assert.notEqual(store.getSummaryDoc("user-A", "file-1"), null);
  store.setFeishuApp("user-A", { clientId: "c", clientSecret: "s" });
  assert.equal(store.getFeishuApp("user-B"), null);
});
