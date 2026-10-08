/**
 * Authorization sessions (plan step 5). Each connect attempt:
 *
 *  1. mints a high-entropy request id and a per-request gateway
 *     `connectionName` alias (`lynse-<request id>`), stored server-side with
 *     a 10-minute TTL;
 *  2. asks the gateway for the authorize URL carrying that alias, and keeps
 *     the upstream `oauthAuthorizationId` when the gateway returns one — the
 *     frontend only ever sees the URL and the opaque request id;
 *  3. completes only when a real gateway connection matches this request's
 *     alias (and authorization id), binding the account in one transaction;
 *  4. a new pending request for the same principal/provider/target supersedes
 *     the old one; different users or target accounts never interfere;
 *  5. completed results stay queryable (and identical) past completion, so a
 *     re-poll after a flaky round trip returns the same account id.
 *
 * Late arrivals whose alias matches nothing are simply never bound; alias
 * cleanup is delete-on-expiry via `purgeStaleAuthorizationRequests`.
 */

import { config } from "./env.mjs";
import { gw } from "./gateway.mjs";
import { accountView } from "./views.mjs";

function connectionProfileFields(connection, provider) {
  const profile = connection.profile ?? {};
  const label = profile.displayName || profile.accountId || `${provider} account`;
  return {
    email: label.includes("@") ? label : label,
    displayName: label,
    workspaceName: provider === "notion" ? label : undefined,
  };
}

/**
 * Begin a connect (or reconnect) attempt. `targetAccountId` binds the attempt
 * to an existing product account (reconnect keeps its id, plan step 5.4).
 */
export async function beginAuthorization(store, { principal, provider, service, targetAccountId = null, customOAuth }) {
  const request = store.createAuthorizationRequest({
    principal,
    provider,
    service,
    targetAccountId,
    ttlMs: config.authTtlMs,
  });
  store.supersedePendingRequests(principal, provider, targetAccountId, request.id);

  const body = { service, connectionName: request.connection_name };
  if (customOAuth?.client_id && customOAuth?.client_secret) {
    body.clientId = String(customOAuth.client_id);
    body.clientSecret = String(customOAuth.client_secret);
    if (Array.isArray(customOAuth.scopes)) body.requestedScopes = customOAuth.scopes;
  }
  const auth = await gw("/api/oauth/authorizations", { method: "POST", body });
  if (!auth.ok) {
    store.failAuthorizationRequest(request.id, `gateway_${auth.status}`);
    return { ok: false, status: auth.status, json: auth.json };
  }
  const j = auth.json ?? {};
  const authorizationUrl = j.authorizationUrl ?? j.authorization_url ?? j.url;
  if (!authorizationUrl) {
    store.failAuthorizationRequest(request.id, "gateway_missing_authorize_url");
    return { ok: false, status: 502, json: null };
  }
  const oauthAuthorizationId = j.oauthAuthorizationId ?? j.oauth_authorization_id ?? j.authorizationId ?? null;
  if (oauthAuthorizationId) {
    store.setAuthorizationUpstream(request.id, { oauthAuthorizationId: String(oauthAuthorizationId) });
  }
  return {
    ok: true,
    requestId: request.id,
    authorizationUrl,
    expiresAt: request.expires_at,
    clientId: j.clientId ?? null,
    scope: j.scope ?? "",
    redirectUri: j.redirectUri ?? null,
  };
}

/**
 * Poll a request the caller owns. Answers `pending` until a matching gateway
 * connection appears; once done, the same account id is returned for the
 * whole retention window (plan step 5.6).
 */
export async function pollAuthorizationResult(store, { principal, requestId, provider, connections }) {
  store.purgeStaleAuthorizationRequests();
  const request = store.authorizationRequestById(requestId, principal);
  // Not found vs. someone else's request are the same answer (plan: request_id 只作定位).
  if (!request || request.provider !== provider) return { status: "invalid" };
  if (request.status === "done") {
    return { status: "done", accountId: request.account_id, account: accountForRequest(store, request) };
  }
  if (request.status === "expired") return { status: "expired" };
  if (request.status === "superseded") return { status: "superseded" };
  if (request.status === "error") return { status: "error", detail: request.status_detail };

  const alias = request.connection_name;
  const match = connections.find(
    (c) =>
      c.service === request.service &&
      !c.virtual &&
      c.configured &&
      (c.connectionName === alias || c.connection_name === alias || c.name === alias) &&
      (!request.oauth_authorization_id ||
        !c.oauthAuthorizationId ||
        c.oauthAuthorizationId === request.oauth_authorization_id),
  );
  if (!match) return { status: "pending" };

  const outcome = store.completeAuthorizationRequest(request.id, {
    connectionId: match.id,
    connectionName: alias,
    oauthAuthorizationId: match.oauthAuthorizationId ?? null,
    accountFields: connectionProfileFields(match, request.provider),
  });
  if (outcome.request.status !== "done") {
    // Lost a completion race to another poll or a supersede — report truthfully.
    return { status: outcome.request.status === "done" ? "done" : "superseded" };
  }
  return { status: "done", accountId: outcome.account.id, account: accountView(outcome.account) };
}

function accountForRequest(store, request) {
  const account = request.account_id ? store.accountById(request.principal, request.account_id) : null;
  return account ? accountView(account) : null;
}

/** Expired requests answer `expired` until purged; pending past TTL flips. */
export function expireOverdueRequests(store) {
  store.purgeStaleAuthorizationRequests();
}
