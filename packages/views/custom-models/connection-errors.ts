const connectionErrorKeys = {
  missing_key: "customModels.key_missing",
  keychain: "customModels.key_read_failed",
  invalid_endpoint: "customModels.connection_invalid_endpoint",
  invalid_model: "customModels.connection_invalid_model",
  timeout: "customModels.connection_timeout",
  network: "customModels.connection_network",
  access_denied: "customModels.connection_access_denied",
  quota: "customModels.connection_quota",
  not_found: "customModels.connection_not_found",
  rate_limited: "customModels.connection_rate_limited",
  provider_unavailable: "customModels.connection_provider_unavailable",
  request_rejected: "customModels.connection_request_rejected",
  invalid_response: "customModels.connection_invalid_response",
  empty_response: "customModels.connection_empty_response",
} as const;

export function customModelConnectionErrorKey(error: unknown) {
  const code = error instanceof Error ? error.message : error;
  if (typeof code === "string" && Object.hasOwn(connectionErrorKeys, code)) {
    return connectionErrorKeys[code as keyof typeof connectionErrorKeys];
  }
  return "customModels.connection_failed";
}
