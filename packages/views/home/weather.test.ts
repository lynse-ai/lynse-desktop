import { describe, expect, it } from "vitest";
import { parseDailyForecast, weatherConditionKey } from "./weather";

describe("parseDailyForecast", () => {
  it("parses an Open-Meteo daily block into at most three days", () => {
    const days = parseDailyForecast({
      time: ["2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"],
      weather_code: [0, 61, 3, 1],
      temperature_2m_max: [30.1, 29.7, 29.3, 28],
      temperature_2m_min: [23, 20.8, 23.9, 22],
    });
    expect(days).toEqual([
      { date: "2026-09-09", code: 0, maxC: 30.1, minC: 23 },
      { date: "2026-09-10", code: 61, maxC: 29.7, minC: 20.8 },
      { date: "2026-09-11", code: 3, maxC: 29.3, minC: 23.9 },
    ]);
  });

  it("accepts numeric strings and drops rows with missing values", () => {
    const days = parseDailyForecast({
      time: ["2026-09-09", "2026-09-10", "2026-09-11"],
      weather_code: ["2", null, 95],
      temperature_2m_max: [31, 30, 29],
      temperature_2m_min: [22, 21, 20],
    });
    expect(days).toEqual([
      { date: "2026-09-09", code: 2, maxC: 31, minC: 22 },
      { date: "2026-09-11", code: 95, maxC: 29, minC: 20 },
    ]);
  });

  it("returns empty for malformed blocks instead of throwing", () => {
    expect(parseDailyForecast(undefined)).toEqual([]);
    expect(parseDailyForecast("nope")).toEqual([]);
    expect(parseDailyForecast({ time: ["2026-09-09"] })).toEqual([]);
  });
});

describe("weatherConditionKey", () => {
  it("maps each WMO family to its i18n key", () => {
    expect(weatherConditionKey(0)).toBe("home.weather_clear");
    expect(weatherConditionKey(1)).toBe("home.weather_partly_cloudy");
    expect(weatherConditionKey(2)).toBe("home.weather_partly_cloudy");
    expect(weatherConditionKey(3)).toBe("home.weather_overcast");
    expect(weatherConditionKey(45)).toBe("home.weather_fog");
    expect(weatherConditionKey(53)).toBe("home.weather_drizzle");
    expect(weatherConditionKey(65)).toBe("home.weather_rain");
    expect(weatherConditionKey(82)).toBe("home.weather_rain");
    expect(weatherConditionKey(75)).toBe("home.weather_snow");
    expect(weatherConditionKey(86)).toBe("home.weather_snow");
    expect(weatherConditionKey(99)).toBe("home.weather_thunderstorm");
  });

  it("returns null for unmapped codes", () => {
    expect(weatherConditionKey(42)).toBeNull();
  });
});
