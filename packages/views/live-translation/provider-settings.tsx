"use client";

import { Loader2 } from "../icons";
import { Label } from "@lynse/ui/components/ui/label";
import { Input } from "@lynse/ui/components/ui/input";
import { Button } from "@lynse/ui/components/ui/button";
import { useTranslation } from "@lynse/core/i18n/react";
import type { LiveTranslationProviderConfig } from "./types";
import {
  listProviders,
  resolveProvider,
  type ProviderFieldSpec,
} from "./providers";

export interface ProviderSettingsProps {
  config: LiveTranslationProviderConfig;
  /** Editing is disabled while a session is running (capture mode and
   * connections are settled at start). */
  disabled?: boolean;
  /** Called on every field edit; the host owns the (possibly dirty) state. */
  onFieldChange: (providerId: string, fieldKey: string, value: string) => void;
  /** Switch the active provider; the host persists immediately. */
  onProviderChange: (providerId: string) => void;
  /** Persist the current field values. */
  onSave: () => void;
  saving?: boolean;
  saved?: boolean;
  /** Hide the "翻译供应商" label (the host renders its own heading). */
  hideLabel?: boolean;
}

/**
 * Live-translation provider picker shared by the recording page drawer and
 * the settings card: a dropdown of the registered provider plugins plus a
 * schema-driven credential form for the active one. Nothing here is
 * "installed" — every provider is built in; selecting one and entering its
 * key is all it takes. Adding a provider plugin makes it appear in the
 * dropdown automatically; this file never changes.
 */
export function ProviderSettings({
  config,
  disabled,
  onFieldChange,
  onProviderChange,
  onSave,
  saving,
  saved,
  hideLabel,
}: ProviderSettingsProps) {
  const { t } = useTranslation();
  const plugins = listProviders();
  const active = resolveProvider(config.activeProvider);
  const hint = active.hintKey ? t(active.hintKey) : active.hint;

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        {!hideLabel && (
          <Label htmlFor="lt-provider" className="text-2xs">
            {t("live_translation.provider")}
          </Label>
        )}
        <select
          id="lt-provider"
          value={config.activeProvider}
          onChange={(event) => onProviderChange(event.target.value)}
          disabled={disabled}
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary disabled:opacity-50"
        >
          {plugins.map((plugin) => (
            <option key={plugin.id} value={plugin.id}>
              {plugin.nameKey ? t(plugin.nameKey) : plugin.name}
            </option>
          ))}
        </select>
      </div>
      {active.fields.length > 0 && (
        <div className="space-y-2 rounded-lg border border-border bg-card p-3">
          {hint && (
            <p className="text-2xs leading-relaxed text-warning-text">{hint}</p>
          )}
          {active.fields.map((field) => (
            <ProviderField
              key={field.key}
              field={field}
              value={config.values[active.id]?.[field.key] ?? ""}
              disabled={disabled}
              onChange={(value) => onFieldChange(active.id, field.key, value)}
            />
          ))}
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          onClick={onSave}
          disabled={disabled || saving}
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t("live_translation.save_provider_config")}
        </Button>
        {saved && (
          <span className="inline-flex items-center gap-1.5 text-xs text-success">
            <span className="size-1.5 rounded-full bg-success" />
            {t("live_translation.provider_config_saved")}
          </span>
        )}
      </div>
    </div>
  );
}

function ProviderField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: ProviderFieldSpec;
  value: string;
  disabled: boolean | undefined;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const label = field.labelKey ? t(field.labelKey) : field.label ?? field.key;
  const hint = field.hintKey ? t(field.hintKey) : field.hint;
  const fieldId = `lt-provider-${field.key}`;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldId} className="text-2xs">
        {label}
        {field.required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </Label>
      {field.kind === "select" ? (
        <select
          id={fieldId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary disabled:opacity-50"
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.labelKey ? t(option.labelKey) : option.label ?? option.value}
            </option>
          ))}
        </select>
      ) : (
        <Input
          id={fieldId}
          type={field.kind === "password" ? "password" : undefined}
          inputMode={field.key === "pid" || field.key === "appId" ? "numeric" : undefined}
          autoComplete="off"
          placeholder={field.placeholder ?? field.defaultValue}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          className="h-8 text-xs"
        />
      )}
      {hint && <p className="text-3xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}
