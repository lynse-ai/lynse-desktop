import "i18next";

// Local slice of the i18next augmentation that owns the `ui` namespace.
// Declares the `ui` resource keys so packages/ui can validate ui-namespace key
// usage in its own typecheck without depending on @lynse/views.
//
// The resource shape is mirrored from packages/views/locales/{en,zh-Hans}/ui.json.
// Drift between the JSON and these types is not caught by the locale parity
// test — if you add a key to ui.json, mirror it here.
declare global {
  interface I18nResources {
    ui: {
      attach_file: string;
      toggle_sidebar: string;
      pagination_previous: string;
      pagination_next: string;
      copy_code: string;
      plain_text: string;
    };
  }
}

declare module "i18next" {
  interface CustomTypeOptions {
    resources: I18nResources;
  }
}
