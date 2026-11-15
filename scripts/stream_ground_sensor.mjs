#!/usr/bin/env node
/**
 * Live Ground-Station Telemetry -> Earth Trend Graph Webhook Streamer
 *
 * Fetches real-time meteorological observations (Open-Meteo surface telemetry
 * + optional NWS KDEN METAR enrichment near Denver) and streams them to
 * `POST /api/graph/nodes/<station>/webhook` so community or agency edge hardware
 * continuously updates the Earth Trend Graph with full provenance.
 *
 * Usage:
 *   node scripts/stream_ground_sensor.mjs --dry-run
 *   node scripts/stream_ground_sensor.mjs --url http://localhost:3000 --lat 39.74 --lng -104.99 --station kden-ground-01
 */

import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const opts = {
    url: process.env.ETG_BASE_URL || "http://localhost:3000",
    lat: 39.74,
    lng: -104.99,
    station: "kden-denver-ground-01",
    dataset: "nasa_power",
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--url" && argv[i + 1]) {
      opts.url = argv[++i];
    } else if (arg === "--lat" && argv[i + 1]) {
      opts.lat = Number(argv[++i]);
    } else if (arg === "--lng" && argv[i + 1]) {
      opts.lng = Number(argv[++i]);
    } else if (arg === "--station" && argv[i + 1]) {
      opts.station = argv[++i];
    } else if (arg === "--dataset" && argv[i + 1]) {
      opts.dataset = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/stream_ground_sensor.mjs [--url http://localhost:3000] [--lat 39.74] [--lng -104.99] [--station kden-denver-ground-01] [--dataset nasa_power] [--dry-run]"
      );
      process.exit(0);
    }
  }

  if (!Number.isFinite(opts.lat) || opts.lat < -90 || opts.lat > 90) {
    throw new Error(`Invalid --lat value: ${opts.lat}`);
  }
  if (!Number.isFinite(opts.lng) || opts.lng < -180 || opts.lng > 180) {
    throw new Error(`Invalid --lng value: ${opts.lng}`);
  }
  return opts;
}

async function fetchJsonWithTimeout(url, headers = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchLiveGroundTelemetry({ lat, lng, station, dataset }) {
  const omUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,shortwave_radiation&wind_speed_unit=ms`;

  const omData = await fetchJsonWithTimeout(omUrl, {
    Accept: "application/json",
    "User-Agent": "EarthTrendDetective/3.0 (Ground-Station-Streamer)",
  });
  const current = omData?.current ?? {};

  // Optional NWS METAR enrichment when sampling the Denver Front Range showcase
  let nwsStationSummary = null;
  if (Math.abs(lat - 39.74) < 0.75 && Math.abs(lng + 104.99) < 0.75) {
    try {
      const nws = await fetchJsonWithTimeout(
        "https://api.weather.gov/stations/KDEN/observations/latest",
        {
          Accept: "application/geo+json",
          "User-Agent": "EarthTrendDetective/3.0 (Ground-Station-Streamer)",
        },
        3000
      );
      const props = nws?.properties;
      if (props && typeof props.textDescription === "string") {
        nwsStationSummary = {
          stationId: "KDEN",
          description: props.textDescription,
          tempC:
            typeof props.temperature?.value === "number"
              ? Number(props.temperature.value.toFixed(2))
              : null,
          timestamp: props.timestamp ?? null,
        };
      }
    } catch {
      // Optional NWS enrichment degrades silently to Open-Meteo surface telemetry
    }
  }

  const swWm2 =
    typeof current.shortwave_radiation === "number" && Number.isFinite(current.shortwave_radiation)
      ? Number(current.shortwave_radiation.toFixed(1))
      : null;
  const tempC =
    typeof current.temperature_2m === "number" && Number.isFinite(current.temperature_2m)
      ? Number(current.temperature_2m.toFixed(2))
      : null;
  const rhPct =
    typeof current.relative_humidity_2m === "number" && Number.isFinite(current.relative_humidity_2m)
      ? Number(current.relative_humidity_2m.toFixed(1))
      : null;
  const windMs =
    typeof current.wind_speed_10m === "number" && Number.isFinite(current.wind_speed_10m)
      ? Number(current.wind_speed_10m.toFixed(2))
      : null;

  if (tempC === null && swWm2 === null) {
    throw new Error("Upstream Open-Meteo current observation returned no finite measurements");
  }

  const primaryValue = tempC ?? swWm2;
  const primaryUnit = tempC !== null ? "°C" : "W/m²";
  const observedAt =
    typeof current.time === "string" && current.time.length >= 10
      ? current.time.endsWith("Z")
        ? current.time
        : `${current.time}:00Z`
      : new Date().toISOString();

  return {
    nodeId: station,
    payload: {
      device_id: station,
      dataset,
      lat,
      lng,
      value: primaryValue,
      unit: primaryUnit,
      confidence: nwsStationSummary ? 0.96 : 0.93,
      observed_at: observedAt,
      title: `Live Surface Telemetry (${station}${nwsStationSummary ? " · NWS KDEN corroborated" : ""}): ${primaryValue} ${primaryUnit}${swWm2 !== null ? `, SW ${swWm2} W/m²` : ""}${rhPct !== null ? `, RH ${rhPct}%` : ""}`,
      metrics: {
        temperature_2m_c: tempC,
        shortwave_radiation_wm2: swWm2,
        relative_humidity_pct: rhPct,
        wind_speed_10m_ms: windMs,
        nws_corroboration: nwsStationSummary,
      },
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const telemetry = await fetchLiveGroundTelemetry(opts);
  const endpoint = `${opts.url.replace(/\/$/, "")}/api/graph/nodes/${encodeURIComponent(
    telemetry.nodeId
  )}/webhook`;

  if (opts.dryRun) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          endpoint,
          payload: telemetry.payload,
        },
        null,
        2
      )
    );
    return;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(telemetry.payload),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`Webhook POST failed (${res.status}): ${JSON.stringify(body)}`);
  }

  console.log(
    JSON.stringify(
      {
        status: body.status,
        endpoint,
        signalNode: body.signalNode?.uuid ?? null,
        linkedInsights: (body.linkedInsights ?? []).map((n) => n.uuid),
        discoveredConnections: (body.discoveredConnections ?? []).length,
      },
      null,
      2
    )
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[stream_ground_sensor] Error:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
