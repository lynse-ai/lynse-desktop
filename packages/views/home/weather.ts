"use client";

/**
 * Weather (天气) for the Home header strip — three days starting today.
 *
 * Location is resolved from the network, no user input: key-less,
 * CORS-open IP geolocation providers are walked in order (the lookup rides
 * the WiFi/LAN uplink, so the resolved place follows the network the
 * device is currently on). If every IP provider fails, the browser
 * Geolocation API — WiFi access-point positioning on laptops — is the
 * fallback. The forecast itself comes from Open-Meteo (free, key-less):
 * daily WMO weather codes plus high/low temperatures in the location's
 * own timezone.
 */

import { useQuery } from "@tanstack/react-query";

export interface WeatherLocation {
  latitude: number;
  longitude: number;
  /** City name as reported by IP geolocation, when the provider supplies one. */
  city?: string;
}

export interface WeatherDay {
  /** Local calendar date (YYYY-MM-DD) in the forecast timezone. */
  date: string;
  /** WMO weather interpretation code (0 = clear sky … 99 = thunderstorm with hail). */
  code: number;
  maxC: number;
  minC: number;
}

export interface WeatherForecast {
  location: WeatherLocation | null;
  /** Today first, up to three entries. */
  days: WeatherDay[];
}

/** Per-request timeout before falling through to the next provider. */
const REQUEST_TIMEOUT_MS = 5_000;
/** How often the forecast refreshes. */
const REFRESH_MS = 30 * 60_000;

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * IP geolocation providers, tried in order. All are free, key-less and
 * CORS-open; coordinates parse from either numbers or numeric strings.
 */
const IP_PROVIDERS: Array<() => Promise<WeatherLocation>> = [
  async () => {
    const data = await fetchJson("https://ipwho.is/");
    if (!isRecord(data) || data.success === false) throw new Error("ipwho.is declined");
    return locationOrThrow(num(data.latitude), num(data.longitude), str(data.city));
  },
  async () => {
    const data = await fetchJson("https://get.geojs.io/v1/ip/geo.json");
    if (!isRecord(data)) throw new Error("geojs malformed");
    return locationOrThrow(num(data.latitude), num(data.longitude), str(data.city));
  },
  async () => {
    const data = await fetchJson("https://ipapi.co/json/");
    if (!isRecord(data)) throw new Error("ipapi malformed");
    return locationOrThrow(num(data.latitude), num(data.longitude), str(data.city));
  },
];

function locationOrThrow(
  latitude: number | null,
  longitude: number | null,
  city: string | null,
): WeatherLocation {
  if (latitude === null || longitude === null) throw new Error("Missing coordinates");
  return { latitude, longitude, city: city ?? undefined };
}

/**
 * WiFi/network positioning via the browser Geolocation API — used only
 * when every IP provider fails. Note this may surface a permission
 * prompt; that cost is acceptable on the fallback path only.
 */
function locationFromBrowser(): Promise<WeatherLocation> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("Geolocation unavailable"));
      return;
    }
    const timer = setTimeout(() => reject(new Error("Geolocation timeout")), REQUEST_TIMEOUT_MS * 2);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        clearTimeout(timer);
        const { latitude, longitude } = position.coords;
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          resolve({ latitude, longitude });
        } else {
          reject(new Error("Geolocation returned no coordinates"));
        }
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
      { timeout: REQUEST_TIMEOUT_MS * 2, maximumAge: 10 * 60_000 },
    );
  });
}

async function resolveLocation(): Promise<WeatherLocation | null> {
  for (const provider of IP_PROVIDERS) {
    try {
      return await provider();
    } catch {
      // Dead or timed-out source — the next one takes over.
    }
  }
  try {
    return await locationFromBrowser();
  } catch {
    return null; // Offline or every source declined — weather stays hidden.
  }
}

/** Shape of Open-Meteo's `daily` block. */
export function parseDailyForecast(daily: unknown): WeatherDay[] {
  if (!isRecord(daily)) return [];
  const times = Array.isArray(daily.time) ? daily.time : [];
  const codes = Array.isArray(daily.weather_code) ? daily.weather_code : [];
  const maxes = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
  const mins = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];

  const days: WeatherDay[] = [];
  const count = Math.min(times.length, codes.length, maxes.length, mins.length, 3);
  for (let i = 0; i < count; i++) {
    const date = str(times[i]);
    const code = num(codes[i]);
    const maxC = num(maxes[i]);
    const minC = num(mins[i]);
    if (!date || code === null || maxC === null || minC === null) continue;
    days.push({ date, code, maxC, minC });
  }
  return days;
}

async function fetchWeather(): Promise<WeatherForecast> {
  const location = await resolveLocation();
  if (!location) throw new Error("No location source answered");

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", location.latitude.toFixed(4));
  url.searchParams.set("longitude", location.longitude.toFixed(4));
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "3");

  const data = await fetchJson(url.toString());
  if (!isRecord(data)) throw new Error("Open-Meteo malformed");
  const days = parseDailyForecast(data.daily);
  if (days.length === 0) throw new Error("Open-Meteo returned no usable days");
  return { location, days };
}

/**
 * The 3-day forecast starting today, resolved from the current network
 * location. While unresolved or unreachable the query errors and the UI
 * simply hides the strip.
 */
export function useWeather() {
  return useQuery({
    queryKey: ["home-weather"],
    queryFn: fetchWeather,
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/** i18n key for a WMO code's short condition label; null → show no text. */
export function weatherConditionKey(code: number): string | null {
  if (code === 0) return "home.weather_clear";
  if (code === 1 || code === 2) return "home.weather_partly_cloudy";
  if (code === 3) return "home.weather_overcast";
  if (code === 45 || code === 48) return "home.weather_fog";
  if (code >= 51 && code <= 57) return "home.weather_drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "home.weather_rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "home.weather_snow";
  if (code >= 95 && code <= 99) return "home.weather_thunderstorm";
  return null;
}
