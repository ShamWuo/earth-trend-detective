import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCurrentConditionsCache,
  convertSlopeUnitLabel,
  convertTemperatureDisplayValue,
  convertTemperatureUnitLabel,
  degreesToCardinal,
  describeUsAqiBand,
  describeWmoWeatherCode,
  fetchCurrentEarthConditions,
  formatTemperatureDelta,
  formatTemperatureValue,
  inferEmbeddedSeriesUnits,
  isTemperatureAnomalyUnit,
  isTemperatureUnitString,
  parseOpenMeteoCurrentPayload,
} from "@/lib/earth/currentConditionsClient";

describe("currentConditionsClient", () => {
  beforeEach(() => {
    clearCurrentConditionsCache();
  });

  afterEach(() => {
    clearCurrentConditionsCache();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("maps WMO weather codes, compass bearings, US AQI bands, and temperature units accurately", () => {
    expect(describeWmoWeatherCode(0)).toBe("Clear sky");
    expect(describeWmoWeatherCode(95)).toBe("Thunderstorm");
    expect(describeWmoWeatherCode(null)).toBe("Observed conditions");

    expect(degreesToCardinal(0)).toBe("N");
    expect(degreesToCardinal(90)).toBe("E");
    expect(degreesToCardinal(180)).toBe("S");
    expect(degreesToCardinal(270)).toBe("W");
    expect(degreesToCardinal(null)).toBeNull();

    expect(describeUsAqiBand(25)).toBe("Good");
    expect(describeUsAqiBand(75)).toBe("Moderate");
    expect(describeUsAqiBand(165)).toBe("Unhealthy");
    expect(describeUsAqiBand(null)).toBeNull();

    expect(isTemperatureUnitString("°C")).toBe(true);
    expect(isTemperatureUnitString("degC")).toBe(true);
    expect(isTemperatureUnitString("mm/d")).toBe(false);
    expect(isTemperatureUnitString(null)).toBe(false);
  });

  it("converts absolute temperatures (+32 offset) separately from deltas (scale only)", () => {
    expect(formatTemperatureValue(0, "C")).toBe("0.0 °C");
    expect(formatTemperatureValue(0, "F")).toBe("32.0 °F");
    expect(formatTemperatureValue(20, "F")).toBe("68.0 °F");

    expect(formatTemperatureDelta(0.8, "C", 2, true)).toBe("+0.80 °C");
    expect(formatTemperatureDelta(0.8, "F", 2, true)).toBe("+1.44 °F");
    expect(formatTemperatureDelta(-0.5, "F", 2, true)).toBe("-0.90 °F");
  });

  it("parses combined Open-Meteo Forecast + Air Quality payloads and returns null on empty inputs", () => {
    expect(parseOpenMeteoCurrentPayload({ lat: 38.5, lng: -101.2 })).toBeNull();

    const parsed = parseOpenMeteoCurrentPayload({
      lat: 38.5,
      lng: -101.2,
      forecast: {
        elevation: 912,
        timezone: "America/Chicago",
        current: {
          time: "2026-11-14T20:00",
          temperature_2m: 19.4,
          apparent_temperature: 18.1,
          relative_humidity_2m: 42,
          precipitation: 0,
          weather_code: 1,
          cloud_cover: 15,
          surface_pressure: 1013.2,
          wind_speed_10m: 14.5,
          wind_direction_10m: 180,
          wind_gusts_10m: 24.0,
          is_day: 1,
          shortwave_radiation: 320,
        },
        daily: {
          temperature_2m_max: [22.0],
          temperature_2m_min: [9.5],
          uv_index_max: [5.2],
        },
      },
      airQuality: {
        current: {
          time: "2026-11-14T20:00",
          pm2_5: 6.2,
          pm10: 14.8,
          us_aqi: 34,
          uv_index: 4.1,
        },
      },
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.temperatureC).toBe(19.4);
    expect(parsed?.apparentTemperatureC).toBe(18.1);
    expect(parsed?.todayMaxC).toBe(22.0);
    expect(parsed?.todayMinC).toBe(9.5);
    expect(parsed?.relativeHumidityPct).toBe(42);
    expect(parsed?.windSpeedKmh).toBe(14.5);
    expect(parsed?.windCardinal).toBe("S");
    expect(parsed?.weatherLabel).toBe("Mainly clear");
    expect(parsed?.usAqi).toBe(34);
    expect(parsed?.aqiCategory).toBe("Good");
    expect(parsed?.pm25).toBe(6.2);
    expect(parsed?.uvIndex).toBe(4.1);
    expect(parsed?.source).toContain("Open-Meteo Weather");
    expect(parsed?.source).toContain("CAMS Air Quality");
  });

  it("handles upstream 500 or network failures gracefully and caches successful lookups", async () => {
    const failingFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: true }), { status: 500 })
    );
    vi.stubGlobal("fetch", failingFetch);

    const errResult = await fetchCurrentEarthConditions(35.0, -90.0);
    expect(errResult).toBeNull();

    clearCurrentConditionsCache();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const netResult = await fetchCurrentEarthConditions(35.0, -90.0);
    expect(netResult).toBeNull();

    clearCurrentConditionsCache();
    const okFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("air-quality-api.open-meteo.com")) {
        return new Response(
          JSON.stringify({
            current: { us_aqi: 62, pm2_5: 17.5, uv_index: 3.0 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          current: {
            time: "2026-11-14T20:00",
            temperature_2m: 21.2,
            wind_speed_10m: 12.0,
            wind_direction_10m: 90,
            weather_code: 0,
            is_day: 1,
          },
          daily: {
            temperature_2m_max: [24.0],
            temperature_2m_min: [11.0],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", okFetch);

    const first = await fetchCurrentEarthConditions(38.501, -101.201);
    expect(first).not.toBeNull();
    expect(first?.temperatureC).toBe(21.2);
    expect(first?.windCardinal).toBe("E");
    expect(first?.usAqi).toBe(62);
    expect(first?.aqiCategory).toBe("Moderate");
    expect(okFetch).toHaveBeenCalledTimes(2);

    const second = await fetchCurrentEarthConditions(38.504, -101.204);
    expect(second?.temperatureC).toBe(21.2);
    expect(okFetch).toHaveBeenCalledTimes(2);
  });
});


describe("fetchCurrentEarthConditionsDetailed partial & failure diagnostics", () => {
  it("classifies null marine AQ as unavailable while preserving weather metrics", async () => {
    const { fetchCurrentEarthConditionsDetailed, clearCurrentConditionsCache } =
      await import("@/lib/earth/currentConditionsClient");
    clearCurrentConditionsCache();

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("air-quality-api.open-meteo.com")) {
        return new Response(
          JSON.stringify({
            current: { time: "2026-11-14T12:00", us_aqi: null, pm2_5: null, uv_index: null },
          }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          current: {
            time: "2026-11-14T12:00",
            temperature_2m: 26.4,
            apparent_temperature: 28.0,
            relative_humidity_2m: 72,
            wind_speed_10m: 18,
            wind_direction_10m: 90,
            wind_gusts_10m: 24,
            weather_code: 1,
            precipitation: 0,
            surface_pressure: 1014,
            cloud_cover: 15,
            shortwave_radiation: 620,
          },
          daily: { temperature_2m_max: [28], temperature_2m_min: [24] },
        }),
        { status: 200 }
      );
    });

    try {
      const res = await fetchCurrentEarthConditionsDetailed(22.11, 60.21);
      expect(res.current).not.toBeNull();
      expect(res.current?.temperatureC).toBeCloseTo(26.4, 1);
      expect(res.diagnostics.weatherStatus).toBe("ok");
      expect(res.diagnostics.airQualityStatus).toBe("unavailable");
    } finally {
      spy.mockRestore();
      clearCurrentConditionsCache();
    }
  });

  it("classifies AQ HTTP 503 as failed_to_fetch while keeping weather metrics", async () => {
    const { fetchCurrentEarthConditionsDetailed, clearCurrentConditionsCache } =
      await import("@/lib/earth/currentConditionsClient");
    clearCurrentConditionsCache();

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("air-quality-api.open-meteo.com")) {
        return new Response("Service Unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify({
          current: {
            time: "2026-11-14T12:00",
            temperature_2m: 25.2,
            relative_humidity_2m: 68,
            wind_speed_10m: 14,
            weather_code: 0,
          },
          daily: { temperature_2m_max: [27], temperature_2m_min: [23] },
        }),
        { status: 200 }
      );
    });

    try {
      const res = await fetchCurrentEarthConditionsDetailed(22.22, 60.32);
      expect(res.current).not.toBeNull();
      expect(res.current?.temperatureC).toBeCloseTo(25.2, 1);
      expect(res.diagnostics.weatherStatus).toBe("ok");
      expect(res.diagnostics.airQualityStatus).toBe("failed_to_fetch");
    } finally {
      spy.mockRestore();
      clearCurrentConditionsCache();
    }
  });

  it("returns non-null current AQ/UV metrics when weather HTTP 503 fails", async () => {
    const { fetchCurrentEarthConditionsDetailed, clearCurrentConditionsCache } =
      await import("@/lib/earth/currentConditionsClient");
    clearCurrentConditionsCache();

    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("air-quality-api.open-meteo.com")) {
        return new Response(
          JSON.stringify({
            current: { time: "2026-11-14T12:00", us_aqi: 42, pm2_5: 9.8, uv_index: 5.5 },
          }),
          { status: 200 }
        );
      }
      return new Response("Service Unavailable", { status: 503 });
    });

    try {
      const res = await fetchCurrentEarthConditionsDetailed(22.33, 60.43);
      expect(res.current).not.toBeNull();
      expect(res.current?.temperatureC).toBeNull();
      expect(res.current?.usAqi).toBe(42);
      expect(res.current?.pm25).toBeCloseTo(9.8, 1);
      expect(res.current?.uvIndex).toBeCloseTo(5.5, 1);
      expect(res.current?.weatherLabel).toBe("Live Air Quality & UV");
      expect(res.diagnostics.weatherStatus).toBe("failed_to_fetch");
      expect(res.diagnostics.airQualityStatus).toBe("ok");
    } finally {
      spy.mockRestore();
      clearCurrentConditionsCache();
    }
  });

  it("handles qualified and anomaly temperature units without applying +32 to anomalies", () => {
    expect(isTemperatureUnitString("°C skin")).toBe(true);
    expect(isTemperatureUnitString("°C max")).toBe(true);
    expect(isTemperatureUnitString("°C anom")).toBe(true);
    expect(isTemperatureUnitString("°C/yr")).toBe(false);

    expect(isTemperatureAnomalyUnit("°C anom")).toBe(true);
    expect(isTemperatureAnomalyUnit("°C skin")).toBe(false);

    expect(convertTemperatureUnitLabel("°C skin", "F")).toBe("°F skin");
    expect(convertTemperatureUnitLabel("°C anom", "F")).toBe("°F anom");
    expect(convertSlopeUnitLabel("°C/yr", "F")).toBe("°F/yr");

    expect(convertTemperatureDisplayValue(20, "°C skin", "F")).toBeCloseTo(68, 2);
    expect(convertTemperatureDisplayValue(1.2, "°C anom", "F")).toBeCloseTo(2.16, 2);
    expect(convertTemperatureDisplayValue(2.16, "°F anom", "C")).toBeCloseTo(1.2, 2);

    expect(
      inferEmbeddedSeriesUnits({
        slope_unit: "°C/yr",
        parameter: "GISTEMP 64N-90N",
        dataset: "nasa_power",
      })
    ).toEqual({ unit: "°C anom", slopeUnit: "°C/yr" });
  });
});
