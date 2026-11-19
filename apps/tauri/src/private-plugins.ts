type Resources = Record<string, { translation: Record<string, unknown> }>;

export function installPrivatePlugins(): void {}

export function withPrivatePluginLocales(resources: Resources): Resources {
  return resources;
}
