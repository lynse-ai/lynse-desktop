"use client";

import { useState } from "react";
import { Input } from "@lynse/ui/components/ui/input";
import { Label } from "@lynse/ui/components/ui/label";
import { Button } from "@lynse/ui/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@lynse/ui/components/ui/select";
import { useTheme } from "@lynse/ui/components/common/theme-provider";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import { Copy, Download } from "../icons";
import {
  APP_THEME_GROUPS,
  APP_THEME_PRESET_IDS,
  getAppThemePreset,
  getAppThemePresetAccent,
  getAppThemePresetName,
  getAppThemeState,
  resetAppTheme,
  selectAppThemePreset,
  setAppThemeAccent,
  setAppThemeBackground,
  setAppThemeFont,
  setAppThemeForeground,
  type AppFontId,
  type AppThemeGroupId,
  type AppThemePresetId,
  type AppThemeState,
} from "./app-theme";

/** Theme-driven mini window mockup, so previews show the selected palette. */
function ThemeMockup({
  presetId,
  variant,
}: {
  presetId: AppThemePresetId;
  variant: "light" | "dark";
}) {
  const theme = getAppThemePreset(presetId, variant);
  const colors = {
    background: theme.colors.background,
    rail: variant === "light"
      ? `color-mix(in srgb, ${theme.colors.background} 94%, black)`
      : `color-mix(in srgb, ${theme.colors.background} 86%, black)`,
    line: `color-mix(in srgb, ${theme.colors.accent} 42%, ${theme.colors.background})`,
    strong: `color-mix(in srgb, ${theme.colors.accent} 78%, ${theme.colors.background})`,
    accent: theme.colors.accent,
  };

  return (
    <div className="flex h-full w-full overflow-hidden" style={{ background: colors.background }} aria-hidden="true">
      <div className="flex w-1/4 flex-col gap-1.5 p-2" style={{ background: colors.rail }}>
        <span className="size-1.5 rounded-full" style={{ background: colors.accent }} />
        <span className="h-1 w-full rounded-full" style={{ background: colors.line }} />
        <span className="h-1 w-3/4 rounded-full" style={{ background: colors.line }} />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2.5 pt-3">
        <span className="h-1.5 w-2/5 rounded-full" style={{ background: colors.strong }} />
        <span className="h-1 w-full rounded-full" style={{ background: colors.line }} />
        <span className="h-1 w-11/12 rounded-full" style={{ background: colors.line }} />
        <span className="h-1 w-4/5 rounded-full" style={{ background: colors.line }} />
      </div>
    </div>
  );
}

function ThemePreviewCards({
  mode,
  onModeChange,
  labels,
  presetId,
}: {
  mode: "system" | "light" | "dark";
  onModeChange: (mode: "system" | "light" | "dark") => void;
  labels: Record<"system" | "light" | "dark", string>;
  presetId: AppThemePresetId;
}) {
  return (
    <div className="grid grid-cols-3 gap-2.5">
      {(["system", "light", "dark"] as const).map((variant) => (
        <button
          key={variant}
          type="button"
          onClick={() => onModeChange(variant)}
          aria-pressed={mode === variant}
          className={cn(
            "h-20 overflow-hidden rounded-xl border-2 transition-[border-color] focus-visible:outline-hidden focus-visible:ring-3 focus-visible:ring-ring/50",
            mode === variant ? "border-primary" : "border-border hover:border-muted-foreground/30",
          )}
          aria-label={labels[variant]}
        >
          <div className="h-full overflow-hidden">
            {variant === "system" ? (
              <div className="grid h-full grid-cols-2" aria-hidden="true">
                <ThemeMockup presetId={presetId} variant="light" />
                <ThemeMockup presetId={presetId} variant="dark" />
              </div>
            ) : (
              <ThemeMockup presetId={presetId} variant={variant} />
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

function ThemeGlyph({ accent }: { accent: string }) {
  return (
    <span
      className="flex size-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold"
      style={{ backgroundColor: `${accent}22`, color: accent }}
      aria-hidden="true"
    >
      Aa
    </span>
  );
}

function ColorPill({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (hex: string | undefined) => void;
  label: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? value;
  const valid = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(text);

  const commit = () => {
    if (draft == null) return;
    if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(draft.trim())) {
      const hex = draft.trim();
      const body = hex.slice(1);
      const expanded = body.length === 3
        ? `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`
        : hex;
      onChange(expanded.toLowerCase());
    } else {
      onChange(undefined);
    }
    setDraft(null);
  };

  return (
    <div className="flex h-8 items-center gap-2 rounded-full border border-border bg-background/40 pr-3 pl-2">
      <label
        className="relative size-4 shrink-0 cursor-pointer rounded-full border border-border"
        style={{ background: value }}
        aria-label={label}
      >
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
      <Input
        value={text}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
        }}
        aria-invalid={!valid}
        className={cn(
          "h-auto w-20 rounded-none border-0 bg-transparent p-0 font-mono text-sm tracking-wide uppercase shadow-none focus-visible:ring-0",
          !valid && "text-destructive",
        )}
      />
    </div>
  );
}

function AccentSourceSelect({
  custom,
  labels,
  onChange,
}: {
  custom: boolean;
  labels: { theme: string; custom: string };
  onChange: (custom: boolean) => void;
}) {
  return (
    <Select
      items={[
        { value: "theme", label: labels.theme },
        { value: "custom", label: labels.custom },
      ]}
      value={custom ? "custom" : "theme"}
      onValueChange={(value) => onChange(value === "custom")}
    >
      <SelectTrigger size="sm" className="min-w-20 rounded-full" aria-label={labels.custom}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="theme">{labels.theme}</SelectItem>
        <SelectItem value="custom">{labels.custom}</SelectItem>
      </SelectContent>
    </Select>
  );
}

function SettingsRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 py-2.5">
      <Label className="shrink-0 text-sm">{label}</Label>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">{children}</div>
    </div>
  );
}

function groupLabelKey(id: AppThemeGroupId): string {
  return `settings.theme_group_${id}`;
}

export function AppearanceSection() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { t } = useTranslation();
  const [state, setState] = useState<AppThemeState>(() => getAppThemeState());
  const mode = resolvedTheme === "dark" ? "dark" : "light";

  const preset = getAppThemePreset(state.preset, mode);
  const accent = state.accent ?? preset.colors.accent;
  const background = state.background ?? preset.colors.background;
  const foreground = state.foreground ?? preset.colors.foreground;
  const themeItems = APP_THEME_PRESET_IDS.map((id) => ({ value: id, label: getAppThemePresetName(id) }));

  const exportTheme = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${state.preset}.lynse-theme.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const copyTheme = async () => {
    await navigator.clipboard.writeText(JSON.stringify(state, null, 2));
  };

  return (
    <div className="mx-auto w-full max-w-4xl pb-2">
      <header className="pb-5 pt-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t("settings.appearance")}</h1>
      </header>

      <section className="space-y-4" aria-label={t("settings.visual_style")}>
        <p className="text-sm font-medium">{t("settings.visual_style")}</p>

        <div className="rounded-2xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-6">
            <Label className="shrink-0 text-sm">{t("settings.mode")}</Label>
            <div className="w-[min(21rem,54%)]">
              <ThemePreviewCards
                mode={theme === "light" || theme === "dark" ? theme : "system"}
                onModeChange={setTheme}
                labels={{
                  system: t("layout.theme_system"),
                  light: t("layout.theme_light"),
                  dark: t("layout.theme_dark"),
                }}
                presetId={state.preset}
              />
            </div>
          </div>
        </div>

        <div className="divide-y divide-border/60 rounded-2xl border border-border bg-card px-4">
          <div className="flex items-center justify-between gap-4 py-3.5">
            <Label className="shrink-0 text-sm">{t("layout.theme")}</Label>
            <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={exportTheme}
                aria-label={t("settings.export_theme")}
              >
                <Download className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void copyTheme()}
                aria-label={t("settings.copy_theme")}
              >
                <Copy className="size-3.5" />
              </Button>
              <Select
                items={themeItems}
                value={state.preset}
                onValueChange={(value) => setState(selectAppThemePreset(value as AppThemePresetId))}
              >
                <SelectTrigger
                  size="sm"
                  className="min-w-40 rounded-lg border-primary ring-2 ring-primary/30"
                  aria-label={t("layout.theme")}
                >
                  <ThemeGlyph accent={accent} />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {APP_THEME_GROUPS.map((group) => (
                    <SelectGroup key={group.id}>
                      <SelectLabel>{t(groupLabelKey(group.id))}</SelectLabel>
                      {group.ids.map((id) => (
                        <SelectItem key={id} value={id}>
                          <ThemeGlyph accent={getAppThemePresetAccent(id, mode)} />
                          <span>{getAppThemePresetName(id)}</span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <SettingsRow label={t("settings.accent_color")}>
            <AccentSourceSelect
              custom={state.accent != null}
              labels={{
                theme: t("settings.accent_source_theme"),
                custom: t("settings.accent_source_custom"),
              }}
              onChange={(custom) => {
                setState(setAppThemeAccent(custom ? accent : undefined));
              }}
            />
            <ColorPill
              label={t("settings.accent_color")}
              value={accent}
              onChange={(hex) => setState(setAppThemeAccent(hex))}
            />
          </SettingsRow>

          <SettingsRow label={t("settings.background")}>
            <ColorPill
              label={t("settings.background")}
              value={background}
              onChange={(hex) => {
                setState(setAppThemeBackground(hex === preset.colors.background ? undefined : hex));
              }}
            />
          </SettingsRow>

          <SettingsRow label={t("settings.foreground")}>
            <ColorPill
              label={t("settings.foreground")}
              value={foreground}
              onChange={(hex) => {
                setState(setAppThemeForeground(hex === preset.colors.foreground ? undefined : hex));
              }}
            />
          </SettingsRow>

          <SettingsRow label={t("settings.font")}>
            <Select
              items={[
                { value: "system", label: t("settings.font_system") },
                { value: "sans", label: t("settings.font_sans") },
                { value: "serif", label: t("settings.font_serif") },
                { value: "mono", label: t("settings.font_mono") },
                { value: "geist", label: t("settings.font_geist") },
              ]}
              value={state.font ?? "system"}
              onValueChange={(value) => setState(setAppThemeFont(value as AppFontId))}
            >
              <SelectTrigger size="sm" className="min-w-24 rounded-lg" aria-label={t("settings.font")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">{t("settings.font_system")}</SelectItem>
                <SelectItem value="sans">{t("settings.font_sans")}</SelectItem>
                <SelectItem value="serif">{t("settings.font_serif")}</SelectItem>
                <SelectItem value="mono">{t("settings.font_mono")}</SelectItem>
                <SelectItem value="geist">{t("settings.font_geist")}</SelectItem>
              </SelectContent>
            </Select>
          </SettingsRow>
        </div>

        <div className="flex items-center justify-between">
          <Button type="button" variant="ghost" size="sm" onClick={() => setTheme("system")}>
            {t("settings.advanced")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setTheme("system");
              setState(resetAppTheme());
            }}
          >
            {t("settings.reset_appearance")}
          </Button>
        </div>
      </section>
    </div>
  );
}
