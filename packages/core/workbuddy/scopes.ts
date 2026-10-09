export const WORKBUDDY_CLOUD_SCOPES = ["user.task.readable", "user.task.invokable"] as const;

export function hasWorkBuddyCloudScopes(scope?: string): boolean {
  // Older backend DTOs omit scope; the upstream still validates its grant.
  if (scope === undefined) return true;
  const scopes = new Set(scope.split(/\s+/));
  return WORKBUDDY_CLOUD_SCOPES.every((required) => scopes.has(required));
}
