"use client";

/**
 * Codex-style appearance editor: theme preview cards (system/light/dark) plus
 * a customization panel per mode — presets, accent/background/foreground
 * colors, fonts, translucent sidebar, contrast. State and painting live in
 * app-theme.ts; this file is views only.
 */

import { useState } from "react";
import { Input } from "@lynse/ui/components/ui/input";
import { Label } from "@lynse/ui/components/ui/label";
import { Switch } from "@lynse/ui/components/ui/switch";
import { Slider } from "@lynse/ui/components/ui/slider";
import { Button } from "@lynse/ui/components/ui/button";
import { Textarea } from "@lynse/ui/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@lynse/ui/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@lynse/ui/components/ui/select";
import { useTheme } from "@lynse/ui/components/common/theme-provider";
import { useTranslation } from "@lynse/core/i18n/react";
import { toast } from "sonner";
import { cn } from "@lynse/ui/lib/utils";
import {
  CANONICAL_COLORS,
  CODE_FONT_OPTIONS,
  UI_FONT_OPTIONS,
  UI_FONT_WEIGHT_OPTIONS,
  currentResolvedMode,
  exportAppThemeState,
  getAppThemeState,
  getPresetsForMode,
  importAppThemeState,
  isAppThemeCustomized,
  resetAppThemeRecord,
  selectAppThemePreset,
  updateAppThemeRecord,
  type AppThemePresetId,
  type AppThemeRecord,
  type AppThemeState,
  type CodeFontId,
  type ThemeModeBucket,
  type UiFontId,
  type UiFontWeightId,
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

// ── Color control (swatch button with native picker + hex field) ────────────

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

// ── Per-mode customization panel ────────────────────────────────────────────

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

function presetLabelKey(id: AppThemePresetId): string {
  return `settings.preset_${id}`;
}

function ThemeCustomizePanel({
  mode,
  state,
  onStateChange,
}: {
  mode: ThemeModeBucket;
  state: AppThemeState;
  onStateChange: (state: AppThemeState) => void;
}) {
  const { t } = useTranslation();
  const rec: AppThemeRecord = state[mode];
  const presets = getPresetsForMode(mode);
  const canonical = CANONICAL_COLORS[mode];
  const activePreset = rec.preset === "custom" ? undefined : presets.find((p) => p.id === rec.preset);
  // Codex semantics: preset stays selected underneath; once any control
  // deviates, the dropdown shows Custom while untouched surfaces still come
  // from the preset.
  const customized = isAppThemeCustomized(rec);
  const presetValue = customized ? "custom" : rec.preset;

  const accent = rec.accent ?? activePreset?.colors.accent ?? canonical.accent;
  const background = rec.background ?? activePreset?.colors.background ?? canonical.background;
  const foreground = rec.foreground ?? activePreset?.colors.foreground ?? canonical.foreground;

  const patch = (p: Parameters<typeof updateAppThemeRecord>[1]) =>
    onStateChange(updateAppThemeRecord(mode, p));

  const rowClass = "flex items-center justify-between gap-3 border-b border-border/60 py-2.5 last:border-b-0";

  return (
    <div className="rounded-lg border bg-card/40 px-3.5 pb-1.5 pt-3">
      <div className="flex items-center justify-between gap-2 pb-1">
        <span className="text-xs font-medium text-foreground">
          {t(mode === "light" ? "settings.theme_light_panel" : "settings.theme_dark_panel")}
        </span>
        <Select
          items={[
            ...presets.map((p) => ({ value: p.id, label: t(presetLabelKey(p.id)) })),
            ...(customized ? [{ value: "custom", label: t("settings.preset_custom") }] : []),
          ]}
          value={presetValue}
          onValueChange={(value) =>
            onStateChange(selectAppThemePreset(mode, value as AppThemePresetId))
          }
        >
          <SelectTrigger size="sm" className="min-w-28 rounded-md text-xs" aria-label={t("settings.theme_preset")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {presets.map((p) => (
              <SelectItem key={p.id} value={p.id} className="text-xs">
                {t(presetLabelKey(p.id))}
              </SelectItem>
            ))}
            {customized && (
              <SelectItem value="custom" className="text-xs">
                {t("settings.preset_custom")}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>

      <div className={rowClass}>
        <Label className="text-xs text-muted-foreground">{t("settings.accent_color")}</Label>
        <div className="flex flex-col items-end gap-1.5">
          <ColorField label={t("settings.accent_color")} value={accent} onChange={(hex) => patch({ accent: hex })} />
          <div className="flex gap-1.5">
            {ACCENT_SWATCHES.map((swatch) => (
              <button
                key={swatch}
                type="button"
                aria-label={swatch}
                onClick={() => patch({ accent: swatch })}
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

      <div className={rowClass}>
        <Label className="text-xs text-muted-foreground">{t("settings.bg_color")}</Label>
        <ColorField label={t("settings.bg_color")} value={background} onChange={(hex) => patch({ background: hex })} />
      </div>

      <div className={rowClass}>
        <Label className="text-xs text-muted-foreground">{t("settings.fg_color")}</Label>
        <ColorField label={t("settings.fg_color")} value={foreground} onChange={(hex) => patch({ foreground: hex })} />
      </div>

      <div className={rowClass}>
        <Label className="text-xs text-muted-foreground">{t("settings.ui_font")}</Label>
        <div className="flex gap-1.5">
          <Select
            items={UI_FONT_OPTIONS.map((o) => ({ value: o.id, label: t(o.labelKey) }))}
            value={rec.uiFont ?? "default"}
            onValueChange={(value) => patch({ uiFont: value as UiFontId })}
          >
            <SelectTrigger size="sm" className="min-w-24 rounded-md text-xs" aria-label={t("settings.ui_font")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UI_FONT_OPTIONS.map((option) => (
                <SelectItem key={option.id} value={option.id} className="text-xs">
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            items={UI_FONT_WEIGHT_OPTIONS.map((o) => ({ value: o.id, label: t(o.labelKey) }))}
            value={rec.uiFontWeight ?? "light"}
            onValueChange={(value) => patch({ uiFontWeight: value as UiFontWeightId })}
          >
            <SelectTrigger size="sm" className="min-w-16 rounded-md text-xs" aria-label={t("settings.font_weight")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {UI_FONT_WEIGHT_OPTIONS.map((option) => (
                <SelectItem key={option.id} value={option.id} className="text-xs">
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className={rowClass}>
        <Label className="text-xs text-muted-foreground">{t("settings.content_font")}</Label>
        <Select
          items={[
            { value: "ui", label: t("settings.font_same_as_ui") },
            { value: "serif", label: t("settings.font_serif") },
          ]}
          value={rec.contentFont ?? "ui"}
          onValueChange={(value) => patch({ contentFont: value as "ui" | "serif" })}
        >
          <SelectTrigger size="sm" className="min-w-24 rounded-md text-xs" aria-label={t("settings.content_font")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ui" className="text-xs">{t("settings.font_same_as_ui")}</SelectItem>
            <SelectItem value="serif" className="text-xs">{t("settings.font_serif")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className={rowClass}>
        <Label className="text-xs text-muted-foreground">{t("settings.code_font")}</Label>
        <Select
          items={CODE_FONT_OPTIONS.map((o) => ({ value: o.id, label: t(o.labelKey) }))}
          value={rec.codeFont ?? "default"}
          onValueChange={(value) => patch({ codeFont: value as CodeFontId })}
        >
          <SelectTrigger size="sm" className="min-w-24 rounded-md text-xs" aria-label={t("settings.code_font")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CODE_FONT_OPTIONS.map((option) => (
              <SelectItem key={option.id} value={option.id} className="text-xs">
                {t(option.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className={rowClass}>
        <Label className="text-xs text-muted-foreground">{t("settings.translucent_sidebar")}</Label>
        <Switch
          checked={rec.translucentSidebar ?? false}
          onCheckedChange={(checked) => patch({ translucentSidebar: checked })}
          aria-label={t("settings.translucent_sidebar")}
        />
      </div>

      <div className={rowClass}>
        <Label className="text-xs text-muted-foreground">{t("settings.contrast")}</Label>
        <div className="flex w-40 items-center gap-2">
          <Slider
            value={[rec.contrast ?? 50]}
            min={0}
            max={100}
            onValueChange={(value) => {
              const v = Array.isArray(value) ? value[0] : value;
              patch({ contrast: v === 50 ? undefined : v });
            }}
            aria-label={t("settings.contrast")}
          />
          <span className="w-6 text-right text-2xs tabular-nums text-muted-foreground">
            {rec.contrast ?? 50}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Import dialog ───────────────────────────────────────────────────────────

function ThemeImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (state: AppThemeState) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState(false);

  const handleConfirm = () => {
    if (importAppThemeState(draft)) {
      onImported(getAppThemeState());
      toast.success(t("settings.theme_imported"));
      setDraft("");
      setError(false);
      onOpenChange(false);
    } else {
      setError(true);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("settings.theme_import_title")}</DialogTitle>
        </DialogHeader>
        <Textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(false);
          }}
          placeholder='{ "light": { "accent": "#5e6ad2", … } }'
          className="min-h-32 font-mono text-2xs"
          aria-invalid={error}
        />
        {error && <p className="text-2xs text-destructive">{t("settings.theme_import_invalid")}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("settings.cancel")}
          </Button>
          <Button size="sm" onClick={handleConfirm}>
            {t("settings.theme_import")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Section root ────────────────────────────────────────────────────────────

export function AppearanceSection() {
  const { t } = useTranslation();
  const [state, setState] = useState<AppThemeState>(() => getAppThemeState());
  const [importOpen, setImportOpen] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportAppThemeState());
      toast.success(t("settings.theme_copied"));
    } catch {
      toast.error(t("settings.theme_copy_failed"));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs">{t("layout.theme")}</Label>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2 text-2xs" onClick={handleCopy}>
            {t("settings.theme_copy")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-2xs"
            onClick={() => setImportOpen(true)}
          >
            {t("settings.theme_import")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-2xs"
            onClick={() => {
              const mode = currentResolvedMode();
              setState(resetAppThemeRecord(mode));
            }}
          >
            {t("settings.theme_reset")}
          </Button>
        </div>
      </div>

      <ThemePreviewCards />

      <ThemeCustomizePanel mode="light" state={state} onStateChange={setState} />
      <ThemeCustomizePanel mode="dark" state={state} onStateChange={setState} />

      <ThemeImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={setState}
      />
    </div>
  );
}
