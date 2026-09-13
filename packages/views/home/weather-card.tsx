"use client";

/**
 * Weather block (天气) — the Home header's three-day forecast: a large
 * Apple-style condition icon on the left spans both rows of the today
 * block (high temperature on top, city and condition label underneath —
 * the low temperature rides on the temp's tooltip), followed by compact
 * columns for tomorrow and the day after (day label, small icon, high /
 * low temperatures). While the request runs, a same-sized skeleton keeps
 * the header stable so nothing jumps when the weather lands; a background
 * refresh shows a tiny spinner badge on the today icon's corner; only a
 * definitive failure (no provider / offline) hides the block entirely.
 */

import { useTranslation } from "@lynse/core/i18n/react";
import { Loader2 } from "../icons";
import { useWeather, weatherConditionKey, type WeatherDay } from "./weather";
import { WxCloudIcon, appleWeatherIcon } from "./weather-icons";

export function WeatherStrip() {
  const { t } = useTranslation();
  const { data, isLoading, isFetching } = useWeather();
  // Definitive failure: hide the block so the header keeps a clean corner.
  // While loading, the skeleton holds the space so nothing below jumps.
  if (!isLoading && (!data || data.days.length === 0)) return null;
  const today: WeatherDay | undefined = data?.days[0];
  const upcoming = data?.days.slice(1, 3) ?? [];
  const Icon = today ? appleWeatherIcon(today.code) : WxCloudIcon;
  const conditionKey = today ? weatherConditionKey(today.code) : null;
  const city = data?.location?.city;

  return (
    <div className="flex items-center gap-3">
      {isLoading || !today ? (
        <>
          <span className="size-11 shrink-0 animate-pulse rounded-full bg-muted-foreground/10" />
          <div className="flex flex-col gap-1.5">
            <span className="h-6 w-14 animate-pulse rounded bg-muted-foreground/10" />
            <span className="h-4 w-24 animate-pulse rounded bg-muted-foreground/10" />
          </div>
          {/* The forecast almost always lands as three days — hold their
              space too so the header width doesn't shift on arrival. */}
          <div className="flex items-center gap-3 border-l border-border/60 pl-3">
            <ForecastDaySkeleton />
            <ForecastDaySkeleton />
          </div>
        </>
      ) : (
        <>
          <span className="relative shrink-0">
            <Icon className="size-11" />
            {isFetching && (
              <Loader2
                className="absolute -right-1 -top-1 size-3.5 animate-spin text-muted-foreground"
                strokeWidth={1.5}
              />
            )}
          </span>
          <div className="flex min-w-0 flex-col">
            <span
              className="text-2xl font-semibold leading-none tracking-tight tabular-nums text-foreground"
              title={`${Math.round(today.minC)}° – ${Math.round(today.maxC)}°`}
            >
              {Math.round(today.maxC)}°
            </span>
            <span className="mt-1.5 truncate text-xs text-muted-foreground">
              {city}
              {city && conditionKey ? " · " : ""}
              {conditionKey ? t(conditionKey) : ""}
            </span>
          </div>
          {upcoming.length > 0 && (
            <div className="flex items-center gap-3 border-l border-border/60 pl-3">
              <ForecastDay
                day={upcoming[0]!}
                label={t("home.weather_day_tomorrow")}
              />
              {upcoming.length > 1 && (
                <ForecastDay day={upcoming[1]!} label={t("home.weather_day_after")} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Skeleton matching one compact forecast-day column. */
function ForecastDaySkeleton() {
  return (
    <div className="flex w-10 flex-col items-center gap-1.5">
      <span className="h-3 w-8 animate-pulse rounded bg-muted-foreground/10" />
      <span className="size-5 animate-pulse rounded-full bg-muted-foreground/10" />
      <span className="h-3 w-10 animate-pulse rounded bg-muted-foreground/10" />
    </div>
  );
}

/** Compact forecast-day column: day label over a small condition icon and
 *  the high/low pair (today stays the header's primary block). */
function ForecastDay({ day, label }: { day: WeatherDay; label: string }) {
  const Icon = appleWeatherIcon(day.code);
  return (
    <div
      className="flex w-10 flex-col items-center gap-1"
      title={`${Math.round(day.minC)}° – ${Math.round(day.maxC)}°`}
    >
      <span className="text-2xs leading-tight text-muted-foreground">{label}</span>
      <Icon className="mt-0.5 size-5" />
      <span className="text-xs leading-none tabular-nums text-foreground">
        {Math.round(day.maxC)}°
        <span className="text-muted-foreground"> {Math.round(day.minC)}°</span>
      </span>
    </div>
  );
}
