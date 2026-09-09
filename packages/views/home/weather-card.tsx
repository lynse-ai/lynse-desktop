"use client";

/**
 * Weather strip (天气条) — the Home header's top-right corner. Three
 * same-sized day tiles laid out side by side, today first, each showing
 * the day label, a condition icon, the condition text and the high/low
 * temperatures. Renders nothing while loading or when no provider
 * answers, so the header text keeps the full width on failure.
 */

import { useTranslation } from "@lynse/core/i18n/react";
import { cn } from "@lynse/ui/lib/utils";
import {
  Cloudy,
  CloudSun,
  CloudFog,
  CloudDrizzle,
  CloudRain,
  CloudSnow,
  CloudLightning,
  Sun,
  MapPin,
} from "../icons";
import { useWeather, weatherConditionKey, type WeatherDay } from "./weather";

const DAY_LABEL_KEYS = [
  "home.weather_day_today",
  "home.weather_day_tomorrow",
  "home.weather_day_after",
] as const;

function conditionIcon(code: number): typeof Sun {
  if (code === 0) return Sun;
  if (code === 1 || code === 2) return CloudSun;
  if (code === 45 || code === 48) return CloudFog;
  if (code >= 51 && code <= 57) return CloudDrizzle;
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return CloudRain;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return CloudSnow;
  if (code >= 95) return CloudLightning;
  return Cloudy;
}

function conditionTint(code: number): string {
  if (code <= 2) return "text-amber-500 dark:text-amber-400";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82))
    return "text-sky-500 dark:text-sky-400";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86)
    return "text-sky-300 dark:text-sky-200";
  if (code >= 95) return "text-violet-500 dark:text-violet-400";
  return "text-muted-foreground";
}

function DayTile({ day, index }: { day: WeatherDay; index: number }) {
  const { t } = useTranslation();
  const Icon = conditionIcon(day.code);
  const conditionKey = weatherConditionKey(day.code);
  const condition = conditionKey ? t(conditionKey) : "—";
  return (
    <div className="flex w-20 shrink-0 flex-col items-center gap-1 rounded-xl border border-border/60 bg-muted/30 px-1.5 py-2">
      <span className="text-2xs font-medium text-muted-foreground">
        {t(DAY_LABEL_KEYS[index]!)}
      </span>
      <Icon className={cn("size-5", conditionTint(day.code))} strokeWidth={1.5} />
      <span title={condition} className="max-w-full truncate text-2xs text-foreground">
        {condition}
      </span>
      <span className="text-2xs tabular-nums text-muted-foreground">
        {Math.round(day.maxC)}°
        <span className="text-muted-foreground/60"> / {Math.round(day.minC)}°</span>
      </span>
    </div>
  );
}

export function WeatherStrip() {
  const { data } = useWeather();
  if (!data || data.days.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      {data.location?.city && (
        <span className="flex max-w-full items-center gap-1 text-2xs text-muted-foreground">
          <MapPin className="size-3 shrink-0" strokeWidth={1.5} />
          <span className="max-w-[10rem] truncate">{data.location.city}</span>
        </span>
      )}
      <div className="flex items-stretch gap-1.5">
        {data.days.slice(0, 3).map((day, index) => (
          <DayTile key={day.date} day={day} index={index} />
        ))}
      </div>
    </div>
  );
}
