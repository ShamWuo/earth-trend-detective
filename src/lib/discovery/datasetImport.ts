import crypto from "node:crypto";
import { parseKnmiIndexDat } from "@/lib/agencies/challengeSourcesClient";
import { DATASET_BY_ID } from "@/lib/datasets";
import { getEtgStore, haversineKm, type EtgGraphSnapshot } from "@/lib/graph/etgStore";
import { analyzeTimeSeries, compareRegionalSeries } from "@/lib/stats/trendEngine";
import type { ETGDatasetId, ETGNode, TimeSeriesPoint } from "@/types/etg";

type EtgStoreInstance = ReturnType<typeof getEtgStore>;

interface ParsedLocationGroup {
  name: string;
  lat: number;
  lng: number;
  dataset: ETGDatasetId;
  unit: string;
  slopeUnit: string;
  points: TimeSeriesPoint[];
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(current.trim().replace(/^"|"$/g, ""));
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current.trim().replace(/^"|"$/g, ""));
  return out;
}

/**
 * Parses NASA Giovanni CSV preambles, NASA GES DISC Hydrology Data Rods ASCII (`BEGIN DATA`),
 * KNMI Climate Explorer `.dat` monthly tables, AppEEARS Point CSV, NOAA CDO CSV, and Geo.ca CSV.
 */
export function parseAgencyFormattedText(
  rawText: string,
  defaults?: {
    defaultName?: string;
    defaultLat?: number;
    defaultLng?: number;
    defaultDataset?: ETGDatasetId;
    defaultUnit?: string;
  }
): Array<Record<string, unknown>> {
  const lines = rawText.split(/\r?\n/);

  // 1. Check for KNMI `.dat` monthly index table (`YEAR JAN FEB ... DEC`)
  const hasKnmiHeader = lines.some(
    (l) => l.startsWith("#") && /climexp\.knmi|YEAR\s+JAN/i.test(l)
  ) || lines.some((l) => /^\s*(19|20)\d{2}(\s+-?\d+\.\d+){6,12}\s*$/.test(l));
  if (hasKnmiHeader && !rawText.includes(",")) {
    const points = parseKnmiIndexDat(rawText, 1880, 2100);
    if (points.length >= 5) {
      const headerContext = [
        defaults?.defaultName ?? "",
        ...lines.filter((l) => l.startsWith("#")).slice(0, 12),
      ].join(" ");
      let inferredKnmiDataset: ETGDatasetId = "nasa_power";
      if (
        /\b(?:sst|ersst|hadisst|nino|niño|enso|amo|pdo|iod|sea\s*surface|sea\s*ice|ocean)\b/i.test(
          headerContext
        )
      ) {
        inferredKnmiDataset = "ocean_temp";
      } else if (
        /\b(?:precip|rain|discharge|river|runoff|drought|soil|moisture)\b/i.test(
          headerContext
        )
      ) {
        inferredKnmiDataset = "hydrology";
      }
      return points.map((p) => ({
        name: defaults?.defaultName || "KNMI Climate Explorer Series",
        lat: defaults?.defaultLat ?? 0,
        lng: defaults?.defaultLng ?? 0,
        date: p.date,
        value: p.value,
        unit: defaults?.defaultUnit || "index",
        dataset: defaults?.defaultDataset ?? inferredKnmiDataset,
      }));
    }
  }

  // 2. Check for NASA GES DISC Hydrology Data Rods ASCII (`BEGIN DATA`)
  const beginDataIdx = lines.findIndex((l) => /^BEGIN DATA\s*$/i.test(l.trim()));
  if (beginDataIdx >= 0) {
    let lat = defaults?.defaultLat;
    let lng = defaults?.defaultLng;
    let paramName = defaults?.defaultName || "NASA GES DISC Data Rods Hydrology";
    for (const metaLine of lines.slice(0, beginDataIdx)) {
      const latM = metaLine.match(/lat(?:itude)?\s*[:=]\s*([-+]?\d+(?:\.\d+)?)/i);
      const lngM = metaLine.match(/(?:lon|lng|longitude)\s*[:=]\s*([-+]?\d+(?:\.\d+)?)/i);
      const pM = metaLine.match(/(?:parameter|variable)\s*[:=]\s*(.+)$/i);
      if (latM) lat = Number(latM[1]);
      if (lngM) lng = Number(lngM[1]);
      if (pM && !defaults?.defaultName) paramName = pM[1].trim();
    }

    const out: Array<Record<string, unknown>> = [];
    for (let i = beginDataIdx + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || /^END DATA/i.test(trimmed) || trimmed.startsWith("#")) continue;
      if (/^Date\b|^Timestamp\b/i.test(trimmed)) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) continue;
      const val = Number(parts[1]);
      if (!Number.isFinite(val) || val <= -900) continue;
      out.push({
        name: paramName,
        lat: lat ?? 0,
        lng: lng ?? 0,
        date: parts[0],
        value: val,
        unit: defaults?.defaultUnit || "kg/m²",
        dataset: defaults?.defaultDataset ?? "hydrology",
      });
    }
    if (out.length > 0) return out;
  }

  // 3. NASA Giovanni CSV with metadata preamble lines before header + standard CSV (AppEEARS / NOAA CDO / Geo.ca)
  let inferredLat = defaults?.defaultLat;
  let inferredLng = defaults?.defaultLng;
  let inferredName = defaults?.defaultName;
  let headerIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    // Extract Giovanni Bounding Box [lonW, latS, lonE, latN] or Location header metadata
    const bboxM = trimmed.match(/Bounding Box:\s*\[?\s*([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)/i);
    if (bboxM) {
      inferredLng = (Number(bboxM[1]) + Number(bboxM[3])) / 2;
      inferredLat = (Number(bboxM[2]) + Number(bboxM[4])) / 2;
    }
    const titleM = trimmed.match(/^(?:#\s*)?(?:Title|Parameter|Variable)\s*:\s*(.+)$/i);
    if (titleM && !inferredName) inferredName = titleM[1].trim();

    if (trimmed.startsWith("#")) continue;

    const cols = splitCsvLine(trimmed);
    const hasDelimiter = cols.length >= 2;
    const looksLikeHeader =
      hasDelimiter &&
      cols.some((c) => /^(time|date|year|timestamp|latitude|lat|station|name)$/i.test(c));
    if (looksLikeHeader) {
      headerIdx = i;
      break;
    }
  }

  const nonComment = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const effectiveLines = headerIdx >= 0 ? lines.slice(headerIdx).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : nonComment;

  if (effectiveLines.length < 2) {
    throw new Error("CSV must include a header row and at least one data row.");
  }

  const headers = splitCsvLine(effectiveLines[0]).map((h) => h.toLowerCase());
  const rows: Array<Record<string, unknown>> = [];

  for (let i = 1; i < effectiveLines.length; i++) {
    const vals = splitCsvLine(effectiveLines[i]);
    if (vals.length === 0 || (vals.length === 1 && !vals[0])) continue;
    const row: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      row[h] = vals[idx] ?? "";
    });

    // Normalize Giovanni / AppEEARS / NOAA CDO / Geo.ca column names cleanly
    if (row.time && !row.date) row.date = row.time;
    if (inferredName && !row.name && !row.station && !row.region) {
      row.name = inferredName;
    }
    if (row.name === undefined && row.station_name) row.name = row.station_name;
    if (inferredLat !== undefined && row.lat === undefined && row.latitude === undefined) {
      row.lat = inferredLat;
    }
    if (inferredLng !== undefined && row.lng === undefined && row.lon === undefined && row.longitude === undefined) {
      row.lng = inferredLng;
    }

    if (
      row.value === undefined &&
      row.reading === undefined &&
      row.anomaly === undefined &&
      row.measurement === undefined
    ) {
      // Auto-pick NOAA CDO (`tavg`, `prcp`, `tmax`), AppEEARS (`*ndvi*`, `*lst*`), or Giovanni 2-column data column
      const candidateKey =
        headers.find((h) =>
          /^(tavg|prcp|tmax|temp_mean|mean|data|chlor_a|ndvi)$/i.test(h)
        ) ??
        headers.find(
          (h) =>
            /(ndvi|evi|lst|chl|precip|temp|gwet|soil|mean_)/i.test(h) &&
            !/quality|qa|unit|lat|lon|date|time|id/i.test(h)
        ) ??
        headers.find((h, idx) => idx > 0 && Number.isFinite(Number(row[h])) && String(row[h]).trim() !== "");

      if (candidateKey) {
        row.value = row[candidateKey];
        if (!row.name && !row.station) row.name = candidateKey.toUpperCase();
      }
    }

    rows.push(row);
  }
  return rows;
}

function toFractionYear(rawDate: string): { date: string; t: number } | null {
  const trimmed = rawDate.trim();
  if (!trimmed) return null;
  if (/^\d{4}$/.test(trimmed)) {
    return { date: trimmed, t: Number(trimmed) };
  }
  const ym = trimmed.match(/^(\d{4})[-/](\d{1,2})$/);
  if (ym) {
    const y = Number(ym[1]);
    const m = Number(ym[2]);
    return { date: trimmed, t: y + (m - 1) / 12 };
  }
  const ms = Date.parse(trimmed);
  if (Number.isFinite(ms)) {
    const d = new Date(ms);
    return {
      date: trimmed,
      t: d.getUTCFullYear() + d.getUTCMonth() / 12 + d.getUTCDate() / 365.25,
    };
  }
  const num = Number(trimmed);
  if (Number.isFinite(num)) {
    return { date: trimmed, t: num };
  }
  return null;
}

function normalizeDatasetId(raw?: string, fallback: ETGDatasetId = "community"): ETGDatasetId {
  if (raw && raw in DATASET_BY_ID) return raw as ETGDatasetId;
  return fallback;
}

export function importEmpiricalDataset(
  store: EtgStoreInstance,
  input: {
    format: "csv" | "json";
    content: string;
    defaultName?: string;
    defaultLat?: number;
    defaultLng?: number;
    defaultDataset?: ETGDatasetId;
    defaultUnit?: string;
    sourceName?: string;
  }
): {
  importedNodes: ETGNode[];
  connectionsWired: number;
  snapshot: EtgGraphSnapshot;
} {
  store.ensureGovernanceRules();

  const defaultDs = normalizeDatasetId(input.defaultDataset, "community");
  const dsMeta = DATASET_BY_ID[defaultDs];
  const defaultUnit = input.defaultUnit?.trim() || dsMeta.unit;
  const sourceSystem = input.sourceName?.trim() || "Imported Empirical Dataset";

  let rawRecords: Array<Record<string, unknown>> = [];
  if (input.format === "csv") {
    rawRecords = parseAgencyFormattedText(input.content, {
      defaultName: input.defaultName,
      defaultLat: input.defaultLat,
      defaultLng: input.defaultLng,
      defaultDataset: input.defaultDataset,
      defaultUnit: input.defaultUnit,
    });
  } else {
    const parsed = JSON.parse(input.content);
    if (Array.isArray(parsed)) {
      rawRecords = parsed as Array<Record<string, unknown>>;
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as any).rows)) {
      rawRecords = (parsed as any).rows;
    } else {
      throw new Error("JSON dataset must be an array of rows or { rows: [...] }.");
    }
  }

  const groups = new Map<string, ParsedLocationGroup>();

  for (const r of rawRecords) {
    const lower: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      lower[k.toLowerCase()] = v;
    }

    const name = String(
      lower.name ?? lower.region ?? lower.station ?? lower.location ?? input.defaultName ?? "Empirical Series"
    ).trim();

    const latRaw = lower.lat ?? lower.latitude ?? input.defaultLat;
    const lngRaw = lower.lng ?? lower.lon ?? lower.longitude ?? input.defaultLng;
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error(`Row for "${name}" is missing valid numeric lat/lng coordinates.`);
    }

    const dateVal = String(lower.year ?? lower.date ?? lower.timestamp ?? lower.t ?? "");
    const parsedTime = toFractionYear(dateVal);
    const val = Number(lower.value ?? lower.reading ?? lower.anomaly ?? lower.measurement);
    if (!parsedTime || !Number.isFinite(val)) continue;

    const ds = normalizeDatasetId(
      typeof lower.dataset === "string" ? lower.dataset : undefined,
      defaultDs
    );
    const unit = String(lower.unit ?? defaultUnit).trim() || dsMeta.unit;
    const slopeUnit = `${unit}/yr`;
    const key = `${name}:${lat.toFixed(3)}:${lng.toFixed(3)}:${ds}`;

    if (!groups.has(key)) {
      groups.set(key, {
        name,
        lat,
        lng,
        dataset: ds,
        unit,
        slopeUnit,
        points: [],
      });
    }
    groups.get(key)!.points.push({
      date: parsedTime.date,
      t: parsedTime.t,
      value: val,
    });
  }

  const validGroups = Array.from(groups.values()).filter((g) => g.points.length >= 5);
  if (validGroups.length === 0) {
    throw new Error(
      "Dataset import requires at least 5 time-series observations per location to compute Mann-Kendall & Theil-Sen significance."
    );
  }

  const conceptUuid = `concept-import-${crypto.createHash("sha1").update(sourceSystem).digest("hex").slice(0, 8)}`;
  if (!store.getNode(conceptUuid)) {
    store.createNode({
      uuid: conceptUuid,
      label: "Concept",
      is_provisional: false,
      silent: true,
      properties: {
        name: sourceSystem,
        concept_name: sourceSystem,
        description: `User-imported empirical scientific dataset (${validGroups.length} geo-pinned series).`,
        status: "Active",
        importance: 8,
        dataset: validGroups[0].dataset,
        producer_type: "research_station",
        source_system: sourceSystem,
        lat: validGroups[0].lat,
        lng: validGroups[0].lng,
      },
    });
  }

  const importedNodes: ETGNode[] = [];
  let connectionsWired = 0;

  for (const g of validGroups) {
    const sorted = [...g.points].sort((a, b) => a.t - b.t);
    const summary = analyzeTimeSeries(sorted, {
      lat: g.lat,
      lng: g.lng,
      dataset: g.dataset,
      parameter: `${g.name} (${g.unit})`,
      unit: g.unit,
      slopeUnit: g.slopeUnit,
      provenance: "Empirical Dataset (Imported)",
    });

    const isSig = summary.mannKendall.significant;
    const latest = sorted[sorted.length - 1];
    const slopeStr = `${summary.theilSen.slope >= 0 ? "+" : ""}${summary.theilSen.slope.toFixed(4)} ${g.slopeUnit}`;

    const signalNode = store.createNode({
      label: "Signal",
      is_provisional: false,
      silent: true,
      properties: {
        name: `${g.name} (${sorted[0]?.date}–${latest?.date})`,
        concept_name: g.name,
        description: `Empirical series from ${sourceSystem}: ${summary.verdict}, Theil-Sen slope ${slopeStr}, Mann-Kendall p=${summary.mannKendall.pValue.toFixed(4)}.`,
        status: "Active",
        importance: isSig ? 8 : 6,
        lat: g.lat,
        lng: g.lng,
        region: g.name,
        dataset: g.dataset,
        producer_type: "research_station",
        source_system: sourceSystem,
        parameter: g.name,
        provenance_source: "Empirical Dataset (Imported)",
        confidence: isSig ? 0.94 : 0.72,
        value: Number(summary.latestValue.toFixed(3)),
        unit: g.unit,
        p_value: summary.mannKendall.pValue,
        p_value_adjusted: summary.mannKendall.pValueAdjusted,
        ols_r2: summary.ols.rSquared,
        regime_shift_year: summary.changePoint?.significant ? summary.changePoint.date : undefined,
        theil_sen_slope: Number(summary.theilSen.slope.toFixed(5)),
        slope_unit: g.slopeUnit,
        series: sorted,
      },
    });

    store.createEdge({
      source_uuid: conceptUuid,
      target_uuid: signalNode.uuid,
      type: "monitors",
      source_snippet: sourceSystem,
      silent: true,
    });

    let targetForConnections = signalNode;

    if (isSig) {
      const dirLabel = summary.theilSen.slope >= 0 ? "Increasing Trend" : "Decreasing Trend";
      const insightNode = store.createNode({
        label: "Insight",
        is_provisional: false,
        silent: true,
        properties: {
          name: `${g.name} · ${dirLabel}`,
          concept_name: `${g.name} ${dirLabel}`,
          description: `Statistically significant ${dirLabel.toLowerCase()} in ${g.name} (p=${summary.mannKendall.pValue.toFixed(4)}, Theil-Sen slope ${slopeStr}).`,
          status: "Active",
          importance: 9,
          lat: g.lat,
          lng: g.lng,
          region: g.name,
          dataset: g.dataset,
          producer_type: "research_station",
          source_system: sourceSystem,
          parameter: g.name,
          provenance_source: "Empirical Dataset (Imported)",
          confidence: 0.93,
          value: Number(summary.latestValue.toFixed(3)),
          unit: g.unit,
          p_value: summary.mannKendall.pValue,
          p_value_adjusted: summary.mannKendall.pValueAdjusted,
          ols_r2: summary.ols.rSquared,
          regime_shift_year: summary.changePoint?.significant ? summary.changePoint.date : undefined,
          theil_sen_slope: Number(summary.theilSen.slope.toFixed(5)),
          slope_unit: g.slopeUnit,
          series: sorted,
        },
      });
      store.createEdge({
        source_uuid: signalNode.uuid,
        target_uuid: insightNode.uuid,
        type: "supports",
        source_snippet: `Mann-Kendall p=${summary.mannKendall.pValue.toFixed(4)}`,
        silent: true,
      });
      store.createEdge({
        source_uuid: "rule-mann-kendall",
        target_uuid: insightNode.uuid,
        type: "verified_by",
        source_snippet: `Verified significant trend (p=${summary.mannKendall.pValue.toFixed(4)})`,
        silent: true,
      });
      importedNodes.push(insightNode);
      targetForConnections = insightNode;
    }

    importedNodes.push(signalNode);

    // Cross-correlate against existing nodes with embedded time-series in the Knowledge Graph
    const existingNodes = store.getSnapshot().nodes;
    let wiredForThisSeries = 0;
    for (const existing of existingNodes) {
      if (wiredForThisSeries >= 4) break;
      if (
        existing.uuid === targetForConnections.uuid ||
        existing.uuid === signalNode.uuid ||
        existing.properties.status === "Superseded"
      ) {
        continue;
      }
      const existingSeries = existing.properties.series ?? store.getNodeSeries(existing.uuid);
      if (!Array.isArray(existingSeries) || existingSeries.length < 5) continue;
      if (existing.properties.lat === undefined || existing.properties.lng === undefined) continue;

      const distKm = haversineKm(g.lat, g.lng, existing.properties.lat, existing.properties.lng);
      if (distKm < 1000) continue;

      const existingSlope = existing.properties.theil_sen_slope ?? 0;
      const comp = compareRegionalSeries(sorted, existingSeries);

      if (summary.theilSen.slope * existingSlope < 0 && comp.pearsonR <= -0.4 && comp.pValue < 0.05) {
        store.createEdge({
          source_uuid: targetForConnections.uuid,
          target_uuid: existing.uuid,
          type: "drives_opposite",
          correlation_r: comp.pearsonR,
          source_snippet: `Imported dataset dipole r=${comp.pearsonR.toFixed(2)}`,
          rationale: `Imported series ${g.name} (${slopeStr}) opposes ${existing.properties.name} (slope ${existingSlope.toFixed(4)}) with Pearson r=${comp.pearsonR.toFixed(2)}, p=${comp.pValue.toFixed(4)}.`,
          silent: true,
        });
        connectionsWired++;
        wiredForThisSeries++;
      } else if (summary.theilSen.slope * existingSlope > 0 && comp.pearsonR >= 0.75 && comp.pValue < 0.01) {
        store.createEdge({
          source_uuid: targetForConnections.uuid,
          target_uuid: existing.uuid,
          type: "correlates_with",
          correlation_r: comp.pearsonR,
          source_snippet: `Imported dataset teleconnection r=${comp.pearsonR.toFixed(2)}`,
          rationale: `Imported series ${g.name} co-trends strongly with ${existing.properties.name} (r=${comp.pearsonR.toFixed(2)}, p=${comp.pValue.toFixed(4)}).`,
          silent: true,
        });
        connectionsWired++;
        wiredForThisSeries++;
      }
    }
  }

  const snapshot = store.recordActivity({
    kind: "dataset",
    summary: `Imported "${sourceSystem}" (${validGroups.length} regional series, ${connectionsWired} graph connections wired).`,
  });

  return {
    importedNodes,
    connectionsWired,
    snapshot,
  };
}
