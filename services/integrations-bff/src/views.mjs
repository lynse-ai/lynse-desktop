/**
 * Contract-shape views. Registry rows never leak the principal, gateway
 * connection ids stay internal (clients use product account ids), and the
 * response shapes mirror `e2e/fixtures/integrations-mock.ts`.
 */

export function accountView(account) {
  return {
    id: account.id,
    email: account.email ?? account.display_name ?? "account",
    display_name: account.display_name ?? account.email ?? "account",
    ...(account.workspace_name ? { workspace_name: account.workspace_name } : {}),
    is_primary: Boolean(account.is_primary),
    sync_enabled: Boolean(account.sync_enabled),
    notify_enabled: Boolean(account.notify_enabled),
    auto_export: Boolean(account.auto_export),
    default_destination_id: account.default_destination_id ?? null,
  };
}
