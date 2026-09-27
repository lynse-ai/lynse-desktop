"use client";

/**
 * Simple appearance settings (Codex-style preview cards): theme mode cards,
 * a theme preset picker (applies to both light and dark), and a single
 * accent color. State and painting live in app-theme.ts.
 */

import { useState } from "react";
import { Input } from "@lynse/ui/components/ui/input";
import { Label } from "@lynse/ui/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lynse/ui/components/ui/select";
import { useTheme } from "@lynse/ui/components/common/theme-provider";
import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import {
  APP_THEME_PRESET_IDS,
  CANONICAL_COLORS,
  currentResolvedMode,
  getAppThemeState,
  selectAppThemePreset,
  setAppThemeAccent,
  type AppThemePresetId,
  type AppThemeState,
} from "./app-theme";

// ── Theme preview cards (Codex-style mockups) ───────────────────────────────

/** Fixed-palette mini window mockup — always renders the target look, so the
 * light card looks light even while the app is in dark mode. */
function ThemeMockup({ variant }: { variant: "light" | "dark" }) {
  const c =
    variant === "light"
      ? { bg: "#ffffff", rail: "#f5f5f5", line: "#d9d9de", strong: "#c3c3c9", accent: "#5f67d8" }
      : { bg: "#17181b", rail: "#0a0b0d", line: "#33343a", strong: "#4a4b52", accent: "#e0b15c" };
  return (
    <div
      className="flex h-full w-full overflow-hidden"
      style={{ background: c.bg }}
      aria-hidden="true"
    >
      <div className="flex w-1/4 flex-col gap-1.5 p-2" style={{ background: c.rail }}>
        <span className="size-1.5 rounded-full" style={{ background: c.accent }} />
        <span className="h-1 w-full rounded-full" style={{ background: c.line }} />
        <span className="h-1 w-3/4 rounded-full" style={{ background: c.line }} />
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2.5 pt-3">
        <span className="h-1.5 w-2/5 rounded-full" style={{ background: c.strong }} />
        <span className="h-1 w-full rounded-full" style={{ background: c.line }} />
        <span className="h-1 w-11/12 rounded-full" style={{ background: c.line }} />
        <span className="h-1 w-4/5 rounded-full" style={{ background: c.line }} />
      </div>
    </div>
  );
}

export function ThemePreviewCards() {
  const { theme, setTheme } = useTheme();
  const { t } = useTranslation();

  const options: { value: "light" | "dark" | "system"; label: string }[] = [
    { value: "system", label: t("layout.theme_system") },
    { value: "light", label: t("layout.theme_light") },
    { value: "dark", label: t("layout.theme_dark") },
  ];

  return (
    <div className="grid grid-cols-3 gap-2.5">
      {options.map((option) => {
        const isActive = theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => setTheme(option.value)}
            aria-pressed={isActive}
            className={cn(
              "group flex flex-col gap-1.5 rounded-lg border-2 p-1.5 pb-1 transition-[border-color] focus-visible:outline-hidden focus-visible:ring-3 focus-visible:ring-ring/50",
              isActive ? "border-primary" : "border-transparent hover:border-muted-foreground/30"
            )}
          >
            <div className="h-20 overflow-hidden rounded-md border border-border/70">
              {option.value === "system" ? (
                <div className="grid h-full grid-cols-2" aria-hidden="true">
                  <ThemeMockup variant="light" />
                  <ThemeMockup variant="dark" />
                </div>
              ) : (
                <ThemeMockup variant={option.value} />
              )}
            </div>
            <span
              className={cn(
                "text-center text-xs font-medium",
                isActive ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Accent color control (swatch button with native picker + hex field) ─────

const ACCENT_SWATCHES = [
  "#5f67d8",
  "#5e6ad2",
  "#2383e2",
  "#30d158",
  "#64d2ff",
  "#ff375f",
  "#ff9f0a",
  "#e0b15c",
];

function ColorField({
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
      const expanded =
        body.length === 3
          ? `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`
          : hex;
      onChange(expanded.toLowerCase());
    } else {
      onChange(undefined);
    }
    setDraft(null);
  };

  return (
    <div className="flex items-center gap-2">
      <label
        className="relative size-6 shrink-0 cursor-pointer rounded-full border border-border shadow-inner"
        style={{ background: value }}
        aria-label={label}
      >
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 cursor-pointer opacity-0"
        />
      </label>
      <Input
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        aria-invalid={!valid}
        className={cn("h-7 w-24 rounded-md px-2 font-mono text-2xs", !valid && "border-destructive")}
      />
    </div>
  );
}

// ── Section root ────────────────────────────────────────────────────────────

function presetLabelKey(id: AppThemePresetId): string {
  return `settings.preset_${id}`;
}

export function AppearanceSection() {
  const { t } = useTranslation();
  // resolvedTheme re-renders the accent fallback when the mode flips (the
  // Lynse default shows indigo in light, gold in dark).
  const { resolvedTheme } = useTheme();
  const [state, setState] = useState<AppThemeState>(() => getAppThemeState());

  const mode = resolvedTheme === "dark" ? "dark" : currentResolvedMode();
  const presetAccent =
    state.preset === "lynse"
      ? CANONICAL_COLORS[mode].accent
      : state.preset === "linear"
        ? "#5e6ad2"
        : "#2383e2";
  const accent = state.accent ?? presetAccent;

  return (
    <div className="space-y-3">
      <Label className="text-xs">{t("layout.theme")}</Label>
      <ThemePreviewCards />

      <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2.5">
        <Label className="text-xs text-muted-foreground">{t("settings.theme_preset")}</Label>
        <Select
          items={APP_THEME_PRESET_IDS.map((id) => ({ value: id, label: t(presetLabelKey(id)) }))}
          value={state.preset}
          onValueChange={(value) => setState(selectAppThemePreset(value as AppThemePresetId))}
        >
          <SelectTrigger size="sm" className="min-w-28 rounded-md text-xs" aria-label={t("settings.theme_preset")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {APP_THEME_PRESET_IDS.map((id) => (
              <SelectItem key={id} value={id} className="text-xs">
                {t(presetLabelKey(id))}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center justify-between gap-3 py-1">
        <Label className="text-xs text-muted-foreground">{t("settings.accent_color")}</Label>
        <div className="flex flex-col items-end gap-1.5">
          <ColorField
            label={t("settings.accent_color")}
            value={accent}
            onChange={(hex) => setState(setAppThemeAccent(hex))}
          />
          <div className="flex gap-1.5">
            {ACCENT_SWATCHES.map((swatch) => (
              <button
                key={swatch}
                type="button"
                aria-label={swatch}
                onClick={() => setState(setAppThemeAccent(swatch))}
                className={cn(
                  "size-4 rounded-full border transition-transform hover:scale-110",
                  accent.toLowerCase() === swatch ? "border-foreground ring-2 ring-ring/60" : "border-border"
                )}
                style={{ background: swatch }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
