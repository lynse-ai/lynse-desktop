/**
 * One-time migration: legacy shared `state.json` → per-principal SQLite
 * registry (plan step 4).
 *
 * The legacy state has NO owner information, so ownership must come from an
 * explicit, human-reviewed mapping file — email/label/`accounts[0]` guessing
 * is deliberately not implemented (plan step 4.3). Unmapped legacy accounts
 * stay unmapped: users simply reconnect in the browser (plan step 4.5), the
 * legacy file is left untouched as the rollback copy.
 *
 * Usage:
 *   node tools/migrate-state.mjs --state /data/state.json \
 *        --db /data/connectors.sqlite3 \
 *        --mapping mappings.json           # dry-run report (default)
 *   node tools/migrate-state.mjs ... --apply
 *
 * mappings.json:
 *   [
 *     { "connection_id": "<gateway connection id>", "principal": "<lynse user id>",
 *       "provider": "google-calendar",       // optional; derived from the legacy account when omitted
 *       "account_id": "acct-google-calendar-3" }  // optional; keep a legacy product id
 *   ]
 *
 * Repeatable: applied rows are idempotent (unique principal+provider+connection),
 * so re-running after a partial apply creates nothing new.
 */

import { readFileSync, existsSync, copyFileSync } from "node:fs";
import { Store } from "../src/store.mjs";

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--apply") args.apply = true;
    else args[key.replace(/^--/, "")] = argv[++i];
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.state || !args.db || !args.mapping) {
  console.error("usage: node tools/migrate-state.mjs --state <state.json> --db <registry.sqlite3> --mapping <mappings.json> [--apply]");
  process.exit(2);
}

if (!existsSync(args.state)) {
  console.error(`legacy state not found: ${args.state}`);
  process.exit(2);
}
const legacy = JSON.parse(readFileSync(args.state, "utf8"));
const legacyAccounts = legacy.accounts ?? {};
const mappings = JSON.parse(readFileSync(args.mapping, "utf8"));
if (!Array.isArray(mappings)) {
  console.error("mapping file must be a JSON array of { connection_id, principal } entries");
  process.exit(2);
}

// Non-sensitive metadata report (plan step 4.2): no tokens exist in the
// legacy state — the gateway holds those — so nothing secret is printed here.
const byConnection = new Map();
for (const [id, account] of Object.entries(legacyAccounts)) {
  byConnection.set(account.connectionId, { legacyId: id, provider: account.provider, label: account.display_name ?? account.email });
}

const willCreate = [];
const conflicts = new Map();
const unknown = [];
const claims = new Map();
for (const entry of mappings) {
  const meta = byConnection.get(entry.connection_id);
  if (!meta) {
    unknown.push(entry);
    continue;
  }
  const owner = claims.get(entry.connection_id);
  if (owner && owner !== entry.principal) {
    const list = conflicts.get(entry.connection_id) ?? [owner];
    list.push(entry.principal);
    conflicts.set(entry.connection_id, list);
    continue;
  }
  claims.set(entry.connection_id, entry.principal);
  willCreate.push({ ...entry, provider: entry.provider ?? meta.provider, label: meta.label });
}

console.log("== migration dry-run" + (args.apply ? " (apply mode)" : "") + " ==");
console.log(`legacy accounts: ${Object.keys(legacyAccounts).length}, mappings: ${mappings.length}`);
for (const row of willCreate) {
  console.log(`  CREATE ${row.principal} <- ${row.provider} ${row.connection_id} (${row.label})`);
}
for (const [connectionId, principals] of conflicts) {
  console.log(`  CONFLICT ${connectionId} claimed by: ${principals.join(", ")} — resolve in the mapping file`);
}
for (const row of unknown) {
  console.log(`  UNKNOWN ${row.connection_id ?? JSON.stringify(row)} — not present in legacy state`);
}
const unmapped = [...byConnection.keys()].filter((id) => !claims.has(id));
for (const id of unmapped) {
  const meta = byConnection.get(id);
  console.log(`  UNMAPPED ${id} (${meta.provider}, ${meta.label}) — user must reconnect; not auto-exposed`);
}
if (conflicts.size || unknown.length) {
  console.log("refusing to apply: fix conflicts/unknown entries first");
  process.exit(1);
}
if (!args.apply) {
  console.log("dry-run only — re-run with --apply to write");
  process.exit(0);
}

if (!existsSync(`${args.state}.backup`)) {
  copyFileSync(args.state, `${args.state}.backup`);
  console.log(`rollback copy written: ${args.state}.backup`);
}

const store = new Store(args.db);
let created = 0;
let existing = 0;
for (const row of willCreate) {
  const before = store.accountsFor(row.principal, row.provider).find((a) => a.connection_id === row.connection_id);
  const account = store.createAccount({
    principal: row.principal,
    provider: row.provider,
    connectionId: row.connection_id,
    email: row.label,
    displayName: row.label,
  });
  if (before) existing += 1;
  else created += 1;
  if (row.account_id) {
    // Preserve the legacy product id when the caller asked for it and it is
    // still free — keeps old desktop clients' saved references stable.
    const current = store.accountById(row.principal, account.id);
    if (current && row.account_id !== account.id && !store.accountById(row.principal, row.account_id)) {
      store.rebindAccount(row.principal, account.id, { connectionId: row.connection_id });
    }
  }
}
console.log(`applied: created ${created}, already-present ${existing} — safe to re-run`);
store.close();
