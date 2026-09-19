import type { ComponentType } from "react";
import type { LucideIcon } from "../icons";

/** What a plugin packages. `app` ships UI contributions; `model` is a pure
 * asset pack (e.g. an offline transcription model) with no UI of its own. */
export type PluginKind = "app" | "model";

export type PluginCategory =
  | "transcription"
  | "integration"
  | "assistant"
  | "sync"
  | "tool";

export type PluginPlatform = "desktop" | "web";

/**
 * Capability declaration. In v1 this is shown on the community card and used
 * as a code-review checklist — it is not enforced at runtime yet (built-in
 * plugins ship with the app and its signature).
 */
export type PluginPermission =
  | "storage:plugin-scope"
  | "secrets"
  | "background-connection"
  | `events:${string}`
  | `network:${string}`;

export interface PluginSettingsSectionContribution {
  /** Settings nav id. Must be unique; core ids (account, stt, …) are reserved. */
  id: string;
  /** Nav label i18n key; falls back to the plugin's name key. */
  titleKey?: string;
  /** Ordering among plugin-contributed sections (core sections keep their
   * fixed positions). Default 500. */
  order?: number;
  /** Section body. Rendered while the plugin is installed + enabled. */
  component: ComponentType;
}

export interface PluginSidebarItemContribution {
  key: string;
  labelKey: string;
  icon: LucideIcon;
  /** Route path; must start with `/plugin/<id>` to stay off core routes. */
  path: string;
}

export interface PluginContributions {
  settingsSection?: PluginSettingsSectionContribution;
  sidebarItem?: PluginSidebarItemContribution;
  /** Domain events the plugin listens to (see events.ts). */
  eventSubscriptions?: readonly string[];
  /** Headless component mounted by the host while the plugin is installed +
   * enabled; it subscribes to the declared events and renders nothing. */
  subscriberComponent?: ComponentType;
}

export interface PluginLifecycle {
  onInstall?: () => Promise<void> | void;
  onEnable?: () => Promise<void> | void;
  /** Must symmetrically stop everything onEnable started (e.g. call the
   * matching Rust stop command). The host does not clean up for you. */
  onDisable?: () => Promise<void> | void;
  /** Optional cleanup. User data is kept unless explicitly removed here. */
  onUninstall?: () => Promise<void> | void;
}

export interface PluginManifest {
  /** Globally unique, `lynse.<slug>`; model plugins use `lynse.model.<slug>`. */
  id: string;
  kind: PluginKind;
  version: string;
  minAppVersion: string;
  /** i18n key shown on the community card. */
  nameKey: string;
  /** i18n key shown on the community card. */
  descriptionKey: string;
  icon: LucideIcon;
  category: PluginCategory;
  /** Platforms without an entry hide every surface of the plugin. */
  platforms: readonly PluginPlatform[];
  permissions: readonly PluginPermission[];
  contributions?: PluginContributions;
  /** Environment gate on top of `platforms` (e.g. a desktop bridge being
   * present). Mirrors the `getDesktop*Api() != null` idiom. */
  availability?: () => boolean;
  lifecycle?: PluginLifecycle;
  /** One-shot upgrade probe: runs once when no plugin state is persisted yet;
   * returning true seeds the plugin as installed + enabled (PRD §6). Must be
   * read-only and idempotent — the host owns writing the state. */
  migrate?: () => Promise<boolean> | boolean;
}

export interface PluginStateEntry {
  installedAt: number;
  enabled: boolean;
}
