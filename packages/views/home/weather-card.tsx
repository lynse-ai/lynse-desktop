"use client";

/**
 * Weather block (天气) — the Home header's two-line forecast taken from
 * the daily forecast's first day: a large Apple-style condition icon on
 * the left spans both rows, the day's high temperature sits on top with
 * the city and condition label underneath (the low temperature rides on
 * the temp's tooltip). While the request runs, a same-sized skeleton
 * keeps the header stable so nothing jumps when the weather lands; a
 * background refresh shows a tiny spinner badge on the icon's corner;
 * only a definitive failure (no provider / offline) hides the block
 * entirely.
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
  const Icon = today ? appleWeatherIcon(today.code) : WxCloudIcon;
  const conditionKey = today ? weatherConditionKey(today.code) : null;
  const city = data?.location?.city;

  return (
    <div className="flex items-center gap-2">
      {isLoading || !today ? (
        <>
          <span className="size-11 shrink-0 animate-pulse rounded-full bg-muted-foreground/10" />
          <div className="flex flex-col gap-1.5">
            <span className="h-6 w-14 animate-pulse rounded bg-muted-foreground/10" />
            <span className="h-4 w-24 animate-pulse rounded bg-muted-foreground/10" />
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
        </>
      )}
    </div>
  );
}
