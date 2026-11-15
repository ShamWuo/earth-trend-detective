import { normalizeEarthCoordinates } from "@/lib/earth/coordinates";
import type {
  CurrentEarthConditions,
  CurrentFeedDiagnostics,
  ETGDatasetId,
  TemperatureUnit,
} from "@/types/etg";

const USER_AGENT =
  "EarthTrendDetective/1.0 (NASA Space Apps; https://github.com/earthtrend-detective)";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

interface CacheEntry {
  expiresAt: number;
  value: CurrentEarthConditions;
  diagnostics: CurrentFeedDiagnostics;
}

const currentCache = new Map<string, CacheEntry>();

const COMPASS_16 = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
] as const;

const WMO_LABELS: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Light rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light rain showers",
  81: "Moderate rain showers",
  82: "Heavy rain showers",
  85: "Light snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** Map a WMO 4677 weather interpretation code to a concise plain-language label. */
export function describeWmoWeatherCode(code: number | null | undefined): string {
  if (typeof code !== "number" || !Number.isFinite(code)) {
    return "Observed conditions";
  }
  const rounded = Math.round(code);
  return WMO_LABELS[rounded] ?? `Weather code ${rounded}`;
}

/** Convert meteorological wind direction in degrees (0-360) into a 16-point compass label. */
export function degreesToCardinal(deg: number | null | undefined): string | null {
  if (typeof deg !== "number" || !Number.isFinite(deg)) {
    return null;
  }
  const normalized = ((deg % 360) + 360) % 360;
  const idx = Math.round(normalized / 22.5) % COMPASS_16.length;
  return COMPASS_16[idx] ?? "N";
}

/** Categorize a US EPA Air Quality Index score into its standard health band. */
export function describeUsAqiBand(aqi: number | null | undefined): string | null {
  if (typeof aqi !== "number" || !Number.isFinite(aqi) || aqi < 0) {
    return null;
  }
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy for Sensitive";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}

const TEMP_QUALIFIED_UNIT_REGEX =
  /^(?:°\s*[cf]|deg\s*[cf]|celsius|fahrenheit)(?:\s+[a-z0-9._-]+)*$/i;
const FAHRENHEIT_UNIT_REGEX = /(?:°\s*f|deg\s*f|fahrenheit)/i;
const CELSIUS_UNIT_REGEX = /(?:°\s*c|deg\s*c|celsius)/i;

/** Return true when a dataset unit string represents absolute or relative temperature in C/F (including qualifiers like "°C skin", "°C max", "°C anom"). */
export function isTemperatureUnitString(unit: string | null | undefined): boolean {
  if (!unit) return false;
  const normalized = unit.trim().toLowerCase();
  if (!normalized || normalized.includes("/")) return false;
  return TEMP_QUALIFIED_UNIT_REGEX.test(normalized);
}

/** Return true when a temperature unit string represents a temperature anomaly / departure (scales by 1.8 for °F without +32 offset). */
export function isTemperatureAnomalyUnit(unit: string | null | undefined): boolean {
  if (!unit) return false;
  return isTemperatureUnitString(unit) && /\banom(?:aly)?\b/i.test(unit);
}

/** Swap Celsius/Fahrenheit scale markers in a temperature unit string while preserving qualifiers like "skin", "max", or "anom". */
export function convertTemperatureUnitLabel(
  unit: string,
  target: TemperatureUnit
): string {
  if (!isTemperatureUnitString(unit)) return unit;
  if (target === "F") {
    return unit.replace(/(?:°\s*c|deg\s*c|celsius)/gi, "°F");
  }
  return unit.replace(/(?:°\s*f|deg\s*f|fahrenheit)/gi, "°C");
}

/** Swap Celsius/Fahrenheit scale markers inside a slope unit string (e.g. "°C/yr" -> "°F/yr"). */
export function convertSlopeUnitLabel(
  slopeUnit: string,
  target: TemperatureUnit
): string {
  if (target === "F") {
    return slopeUnit.replace(/(?:°\s*c|deg\s*c|celsius)/gi, "°F");
  }
  return slopeUnit.replace(/(?:°\s*f|deg\s*f|fahrenheit)/gi, "°C");
}

/** Convert a numeric temperature reading or anomaly to the target display unit. */
export function convertTemperatureDisplayValue(
  value: number,
  sourceUnit: string | null | undefined,
  target: TemperatureUnit
): number {
  if (!isTemperatureUnitString(sourceUnit)) return value;
  const srcIsF = FAHRENHEIT_UNIT_REGEX.test(sourceUnit ?? "");
  if ((target === "F" && srcIsF) || (target === "C" && !srcIsF)) return value;
  const isAnomaly = isTemperatureAnomalyUnit(sourceUnit);
  if (target === "F") {
    return isAnomaly ? value * 1.8 : value * 1.8 + 32;
  }
  return isAnomaly ? value / 1.8 : (value - 32) / 1.8;
}

/** Infer missing unit & slopeUnit metadata on embedded ETG node time series. */
export function inferEmbeddedSeriesUnits(props: {
  unit?: string;
  slope_unit?: string;
  parameter?: string;
  name?: string;
  dataset?: ETGDatasetId;
}): { unit: string; slopeUnit: string } {
  const trimmedUnit = props.unit?.trim();
  const trimmedSlope = props.slope_unit?.trim();
  if (trimmedUnit && trimmedUnit !== "value") {
    return {
      unit: trimmedUnit,
      slopeUnit: trimmedSlope || `${trimmedUnit}/yr`,
    };
  }
  const hint = `${trimmedSlope ?? ""} ${props.parameter ?? ""} ${props.name ?? ""}`;
  if (
    CELSIUS_UNIT_REGEX.test(trimmedSlope ?? "") ||
    (props.dataset === "nasa_power" && /\b(?:anom|gistemp|temp)\b/i.test(hint))
  ) {
    return {
      unit: "°C anom",
      slopeUnit: trimmedSlope || "°C/yr",
    };
  }
  return {
    unit: trimmedUnit || "value",
    slopeUnit: trimmedSlope || "unit/yr",
  };
}

/** Convert a Celsius value to the target display unit and format cleanly. */
export function formatTemperatureValue(
  celsius: number,
  unit: TemperatureUnit,
  decimals = 1
): string {
  const scaled = unit === "F" ? celsius * 1.8 + 32 : celsius;
  const clean = Math.abs(scaled) < Math.pow(10, -(decimals + 1)) ? 0 : scaled;
  const suffix = unit === "F" ? "°F" : "°C";
  return `${clean.toFixed(decimals)} ${suffix}`;
}

/**
 * Convert a temperature interval or slope (delta Celsius, never absolute +32 offset)
 * to the requested display unit.
 */
export function formatTemperatureDelta(
  deltaCelsius: number,
  unit: TemperatureUnit,
  decimals = 2,
  includeSign = true
): string {
  const scaled = unit === "F" ? deltaCelsius * 1.8 : deltaCelsius;
  const epsilon = Math.pow(10, -(decimals + 1));
  const clean = Math.abs(scaled) < epsilon ? 0 : scaled;
  const sign = includeSign && clean > 0 ? "+" : "";
  const suffix = unit === "F" ? "°F" : "°C";
  return `${sign}${clean.toFixed(decimals)} ${suffix}`;
}

/** Normalize raw Open-Meteo Forecast + Air Quality JSON responses into CurrentEarthConditions. */
export function parseOpenMeteoCurrentPayload(input: {
  lat: number;
  lng: number;
  forecast?: unknown;
  airQuality?: unknown;
}): CurrentEarthConditions | null {
  const fc =
    input.forecast && typeof input.forecast === "object"
      ? (input.forecast as Record<string, unknown>)
      : null;
  const aq =
    input.airQuality && typeof input.airQuality === "object"
      ? (input.airQuality as Record<string, unknown>)
      : null;

  const fcCurrent =
    fc?.current && typeof fc.current === "object"
      ? (fc.current as Record<string, unknown>)
      : null;
  const fcDaily =
    fc?.daily && typeof fc.daily === "object"
      ? (fc.daily as Record<string, unknown>)
      : null;
  const aqCurrent =
    aq?.current && typeof aq.current === "object"
      ? (aq.current as Record<string, unknown>)
      : null;

  if (!fcCurrent && !aqCurrent) {
    return null;
  }

  const dailyMaxArr = Array.isArray(fcDaily?.temperature_2m_max)
    ? fcDaily.temperature_2m_max
    : [];
  const dailyMinArr = Array.isArray(fcDaily?.temperature_2m_min)
    ? fcDaily.temperature_2m_min
    : [];
  const dailyUvArr = Array.isArray(fcDaily?.uv_index_max)
    ? fcDaily.uv_index_max
    : [];

  const temperatureC = finiteOrNull(fcCurrent?.temperature_2m);
  const apparentTemperatureC = finiteOrNull(fcCurrent?.apparent_temperature);
  const todayMaxC = finiteOrNull(dailyMaxArr[0]);
  const todayMinC = finiteOrNull(dailyMinArr[0]);
  const relativeHumidityPct = finiteOrNull(fcCurrent?.relative_humidity_2m);
  const precipitationMm = finiteOrNull(fcCurrent?.precipitation);
  const windSpeedKmh = finiteOrNull(fcCurrent?.wind_speed_10m);
  const windGustsKmh = finiteOrNull(fcCurrent?.wind_gusts_10m);
  const windDirectionDeg = finiteOrNull(fcCurrent?.wind_direction_10m);
  const cloudCoverPct = finiteOrNull(fcCurrent?.cloud_cover);
  const surfacePressureHpa = finiteOrNull(fcCurrent?.surface_pressure);
  const shortwaveRadiationWm2 = finiteOrNull(fcCurrent?.shortwave_radiation);
  const weatherCode = finiteOrNull(fcCurrent?.weather_code);
  const isDayRaw = fcCurrent?.is_day;
  const isDay =
    typeof isDayRaw === "number"
      ? isDayRaw === 1
      : typeof isDayRaw === "boolean"
        ? isDayRaw
        : null;

  const pm25 = finiteOrNull(aqCurrent?.pm2_5);
  const pm10 = finiteOrNull(aqCurrent?.pm10);
  const usAqi = finiteOrNull(aqCurrent?.us_aqi);
  const uvIndex = finiteOrNull(aqCurrent?.uv_index) ?? finiteOrNull(dailyUvArr[0]);

  const hasWeatherMetric =
    temperatureC !== null ||
    windSpeedKmh !== null ||
    relativeHumidityPct !== null ||
    precipitationMm !== null ||
    cloudCoverPct !== null ||
    shortwaveRadiationWm2 !== null ||
    surfacePressureHpa !== null;
  const hasAirOrUvMetric =
    pm25 !== null || pm10 !== null || usAqi !== null || uvIndex !== null;

  if (!hasWeatherMetric && !hasAirOrUvMetric) {
    return null;
  }

  const observedAt =
    stringOrNull(fcCurrent?.time) ??
    stringOrNull(aqCurrent?.time) ??
    new Date().toISOString();

  const sources: string[] = [];
  if (fcCurrent && hasWeatherMetric) sources.push("Open-Meteo Weather");
  if (aqCurrent && hasAirOrUvMetric) sources.push("CAMS Air Quality");

  const weatherLabel =
    weatherCode === null && !hasWeatherMetric && hasAirOrUvMetric
      ? "Live Air Quality & UV"
      : describeWmoWeatherCode(weatherCode);

  return {
    lat: Number(input.lat.toFixed(4)),
    lng: Number(input.lng.toFixed(4)),
    observedAt,
    timezone: stringOrNull(fc?.timezone) ?? stringOrNull(aq?.timezone),
    elevationM: finiteOrNull(fc?.elevation),
    temperatureC,
    apparentTemperatureC,
    todayMaxC,
    todayMinC,
    relativeHumidityPct,
    precipitationMm,
    windSpeedKmh,
    windGustsKmh,
    windDirectionDeg,
    windCardinal: degreesToCardinal(windDirectionDeg),
    cloudCoverPct,
    surfacePressureHpa,
    shortwaveRadiationWm2,
    weatherCode,
    weatherLabel,
    isDay,
    pm25,
    pm10,
    usAqi,
    aqiCategory: describeUsAqiBand(usAqi),
    uvIndex,
    source: sources.join(" + ") || "Open-Meteo",
  };
}

/** Clear the in-memory live weather/air quality cache (primarily for tests). */
export function clearCurrentConditionsCache(): void {
  currentCache.clear();
}

type FetchJsonResult =
  | { ok: true; data: unknown }
  | { ok: false; status: "failed_to_fetch"; reason: string };

async function fetchJsonWithStatus(
  url: string,
  feedLabel: string
): Promise<FetchJsonResult> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(3500),
      cache: "no-store",
    });
    if (!res.ok) {
      return {
        ok: false,
        status: "failed_to_fetch",
        reason: `${feedLabel} returned HTTP ${res.status}.`,
      };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    return {
      ok: false,
      status: "failed_to_fetch",
      reason: `${feedLabel}: ${msg}`,
    };
  }
}

/**
 * Fetch real-time weather and air quality conditions for a coordinate,
 * preserving partial results when only one upstream feed responds and
 * distinguishing network/HTTP fetch failures from coordinate coverage gaps.
 */
export async function fetchCurrentEarthConditionsDetailed(
  lat: number,
  lng: number
): Promise<{
  current: CurrentEarthConditions | null;
  diagnostics: CurrentFeedDiagnostics;
}> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return {
      current: null,
      diagnostics: {
        weatherStatus: "unavailable",
        weatherReason: "Invalid coordinate.",
        airQualityStatus: "unavailable",
        airQualityReason: "Invalid coordinate.",
      },
    };
  }

  const coord = normalizeEarthCoordinates(lat, lng);
  const cacheKey = `${coord.lat.toFixed(2)}:${coord.lng.toFixed(2)}`;
  const cached = currentCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      current: { ...cached.value, provenanceMode: "cached" },
      diagnostics: cached.diagnostics,
    };
  }

  const forecastParams = new URLSearchParams({
    latitude: coord.apiLat.toFixed(4),
    longitude: coord.apiLng.toFixed(4),
    current: [
      "temperature_2m",
      "apparent_temperature",
      "relative_humidity_2m",
      "precipitation",
      "weather_code",
      "cloud_cover",
      "surface_pressure",
      "wind_speed_10m",
      "wind_direction_10m",
      "wind_gusts_10m",
      "is_day",
      "shortwave_radiation",
    ].join(","),
    daily: "temperature_2m_max,temperature_2m_min,uv_index_max",
    forecast_days: "1",
    timezone: "auto",
  });

  const aqParams = new URLSearchParams({
    latitude: coord.apiLat.toFixed(4),
    longitude: coord.apiLng.toFixed(4),
    current: "pm2_5,pm10,us_aqi,uv_index",
    timezone: "auto",
  });

  const [forecastRes, airRes] = await Promise.all([
    fetchJsonWithStatus(
      `https://api.open-meteo.com/v1/forecast?${forecastParams.toString()}`,
      "Open-Meteo Weather"
    ),
    fetchJsonWithStatus(
      `https://air-quality-api.open-meteo.com/v1/air-quality?${aqParams.toString()}`,
      "CAMS Air Quality"
    ),
  ]);

  const parsedRaw = parseOpenMeteoCurrentPayload({
    lat: coord.lat,
    lng: coord.lng,
    forecast: forecastRes.ok ? forecastRes.data : undefined,
    airQuality: airRes.ok ? airRes.data : undefined,
  });
  const parsed: CurrentEarthConditions | null = parsedRaw
    ? { ...parsedRaw, provenanceMode: "live" }
    : null;

  const hasWeatherMetrics = Boolean(
    parsed &&
      (parsed.temperatureC !== null ||
        parsed.windSpeedKmh !== null ||
        parsed.relativeHumidityPct !== null ||
        parsed.precipitationMm !== null ||
        parsed.surfacePressureHpa !== null ||
        parsed.cloudCoverPct !== null ||
        parsed.shortwaveRadiationWm2 !== null)
  );
  const hasAirQualityMetrics = Boolean(
    parsed && (parsed.usAqi !== null || parsed.pm25 !== null || parsed.pm10 !== null)
  );

  const diagnostics: CurrentFeedDiagnostics = {
    weatherStatus: !forecastRes.ok
      ? "failed_to_fetch"
      : hasWeatherMetrics
        ? "ok"
        : "unavailable",
    ...(!forecastRes.ok
      ? { weatherReason: forecastRes.reason }
      : !hasWeatherMetrics
        ? { weatherReason: "No live surface weather grid reading for this coordinate." }
        : {}),
    airQualityStatus: !airRes.ok
      ? "failed_to_fetch"
      : hasAirQualityMetrics
        ? "ok"
        : "unavailable",
    ...(!airRes.ok
      ? { airQualityReason: airRes.reason }
      : !hasAirQualityMetrics
        ? {
            airQualityReason:
              "Surface AQI / PM2.5 is not reported at this coordinate (e.g., open water or remote cell).",
          }
        : {}),
  };

  if (
    parsed &&
    diagnostics.weatherStatus !== "failed_to_fetch" &&
    diagnostics.airQualityStatus !== "failed_to_fetch"
  ) {
    if (currentCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = currentCache.keys().next().value;
      if (oldestKey) currentCache.delete(oldestKey);
    }
    currentCache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      value: parsed,
      diagnostics,
    });
  }

  return { current: parsed, diagnostics };
}

/**
 * Fetch real-time weather and air quality conditions for a coordinate.
 * Never throws: returns null gracefully if upstream services are unavailable.
 */
export async function fetchCurrentEarthConditions(
  lat: number,
  lng: number
): Promise<CurrentEarthConditions | null> {
  const { current } = await fetchCurrentEarthConditionsDetailed(lat, lng);
  return current;
}
