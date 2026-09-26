import { definePlugin } from "../registry";
import { WorkBuddy as WorkBuddyIcon } from "../../icons";

/**
 * WorkBuddy assistant — the first plugin contributed to the community
 * (PRD §5.1). The card itself is plain backend HTTP plus the system browser,
 * so the plugin is available everywhere the user is signed in. Its settings
 * card moved into the built-in "AI assistant" section (settings-dialog); the
 * plugin keeps the manifest for future in-product entry points.
 */
export const workbuddyPlugin = definePlugin({
  id: "lynse.workbuddy",
  kind: "app",
  version: "1.0.0",
  minAppVersion: "1.0.4",
  nameKey: "plugins.workbuddy.name",
  descriptionKey: "plugins.workbuddy.description",
  icon: WorkBuddyIcon,
  category: "assistant",
  platforms: ["desktop", "web"],
  permissions: ["network:backend", "network:workbuddy.cn"],
  availability: () => true,
  // Every pre-plugin install had this section unconditionally, so every
  // install (including brand-new ones) comes up installed + enabled. Once
  // WorkBuddy gains real in-product entry points, switch this to a proper
  // legacy-detection probe so fresh installs start without it.
  migrate: () => true,
});
