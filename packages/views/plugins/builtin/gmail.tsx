import { definePlugin } from "../registry";
import { Plug } from "../../icons";
import { isConnectionsEnabled } from "../../feature-flags";

export const gmailPlugin = definePlugin({
  id: "lynse.gmail",
  kind: "app",
  version: "1.0.0",
  minAppVersion: "1.1.15",
  nameKey: "connections.provider.gmail",
  descriptionKey: "connections.hint.gmail",
  icon: Plug,
  category: "integration",
  platforms: ["desktop"],
  permissions: ["network:backend", "network:gmail", "background-connection"],
  contributions: { connectionProvider: { provider: "gmail", kind: "source" } },
  availability: isConnectionsEnabled,
});
