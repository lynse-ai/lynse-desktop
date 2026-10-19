/**
 * Account resolution (plan step 6): every read, disconnect, settings change,
 * destination query and export resolves the account through here, so a
 * request can only ever touch rows owned by the verified principal. The
 * gateway connection behind an account is selected explicitly — never "the
 * first one".
 */

import { accountView } from "./views.mjs";

/**
 * @param {Array} owned  the principal's registry rows for this provider
 * @param {string|undefined} accountId  caller-selected account (optional)
 * @returns {{ok:true, account:object} | {ok:false, error:"connection_required"}
 *   | {ok:false, error:"account_selection_required", accounts:object[]}
 *   | {ok:false, error:"unknown_account"}}
 */
export function resolveAccount(owned, accountId) {
  if (accountId) {
    const account = owned.find((a) => a.id === accountId);
    if (!account) {
      // Either an invented id or another user's — both are the same answer.
      return { ok: false, error: "unknown_account" };
    }
    return { ok: true, account };
  }
  if (!owned.length) return { ok: false, error: "connection_required" };
  if (owned.length > 1) {
    return { ok: false, error: "account_selection_required", accounts: owned.map(accountView) };
  }
  return { ok: true, account: owned[0] };
}

/**
 * Keep only registry rows whose gateway connection still exists and is
 * configured — a revoked-on-gateway connection stops answering as connected
 * instead of erroring every status poll.
 */
export function liveAccounts(ownedRows, connections) {
  const alive = new Set(
    connections.filter((c) => !c.virtual && c.configured).map((c) => c.id),
  );
  return ownedRows.filter((row) => alive.has(row.connection_id));
}
