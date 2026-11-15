import fs from "node:fs";
import path from "node:path";
import type {
  ETGEdge,
  ETGNode,
  ETGWorkspaceBundle,
  EtgActivityEntry,
  ProspectiveForecastRecord,
  TimeSeriesPoint,
} from "@/types/etg";
import {
  DEFAULT_DATA_DIR,
  FORBIDDEN_PATH_SEGMENTS,
  FORECASTS_FILENAME,
  LEGACY_CACHE_DIR,
  MULTISCALE_FILENAME,
  SERIES_FILENAME,
  STATE_FILENAME,
  assertValidEtgLabel,
  computeSparklinePreview,
  normalizeBucketPeriodKey,
  type EtgGraphSnapshot,
  type TemporalBucket,
} from "./etgSeriesAndTrustUtils";
import type { EtgPersistencePaths, EtgStoreContext } from "./etgStoreContext";

export function getPersistencePathsOp(
  persistDir: string | null,
  baseDir?: string | null
): EtgPersistencePaths | null {
  const dir = baseDir ?? persistDir;
  if (!dir) return null;
  return {
    dir,
    stateFile: path.join(dir, STATE_FILENAME),
    seriesFile: path.join(dir, SERIES_FILENAME),
    multiscaleFile: path.join(dir, MULTISCALE_FILENAME),
    forecastsFile: path.join(dir, FORECASTS_FILENAME),
  };
}

export function reconcileSeriesForTargetOp(
  ctx: EtgStoreContext,
  targetUuid: string,
  series: readonly TimeSeriesPoint[]
): number {
  if (ctx.forecasts.size === 0 || series.length === 0) return 0;

  const pendingForTarget = Array.from(ctx.forecasts.values()).filter(
    (f) => f.target_uuid === targetUuid && f.status === "pending"
  );
  if (pendingForTarget.length === 0) return 0;

  let scoredNow = 0;
  const nowIso = new Date().toISOString();

  for (const forecast of pendingForTarget) {
    const matchingVals: number[] = [];
    for (const pt of series) {
      if (!pt || !Number.isFinite(pt.value)) continue;
      const key = normalizeBucketPeriodKey(pt.date, forecast.bucket);
      if (key === forecast.target_period) {
        matchingVals.push(pt.value);
      }
    }
    if (matchingVals.length === 0) continue;

    const actualRaw =
      matchingVals.reduce((sum, v) => sum + v, 0) / matchingVals.length;
    const actual = Number(actualRaw.toFixed(4));
    const absError = Number(Math.abs(actual - forecast.predicted_value).toFixed(4));
    const selfAbsError = Number(
      Math.abs(actual - forecast.self_only_pred).toFixed(4)
    );
    const persistAbsError = Number(
      Math.abs(actual - forecast.persistence_pred).toFixed(4)
    );
    const covered =
      Math.abs(actual - forecast.predicted_value) <=
      forecast.ci95_half_width + 1e-9;

    ctx.forecasts.set(forecast.id, {
      ...forecast,
      status: "scored",
      actual_value: actual,
      reconciled_at: nowIso,
      abs_error: absError,
      self_abs_error: selfAbsError,
      persistence_abs_error: persistAbsError,
      covered_by_ci95: covered,
    });
    scoredNow += 1;
  }

  return scoredNow;
}

export function offloadNodeSeriesOp(
  ctx: EtgStoreContext,
  uuid: string,
  props: ETGNode["properties"]
): ETGNode["properties"] {
  const { series, ...rest } = props;
  if (Array.isArray(series) && series.length > 0) {
    ctx.seriesByNode.set(uuid, series);
    if (!ctx.loadingState && ctx.forecasts.size > 0) {
      ctx.reconcileSeriesForTarget(uuid, series);
    }
    const preview = computeSparklinePreview(series, 16);
    return {
      ...rest,
      series_count: series.length,
      sparkline_preview: preview ?? rest.sparkline_preview,
    };
  }
  if (ctx.seriesByNode.has(uuid)) {
    const existing = ctx.seriesByNode.get(uuid)!;
    const preview = computeSparklinePreview(existing, 16);
    return {
      ...rest,
      series_count: existing.length,
      sparkline_preview: preview ?? rest.sparkline_preview,
    };
  }
  return rest;
}

export function loadInitialStateOp(ctx: EtgStoreContext): void {
  ctx.nodes = new Map();
  ctx.edges = new Map();
  ctx.seriesByNode = new Map();
  ctx.multiScaleSeriesByNode = new Map();
  ctx.forecasts = new Map();
  ctx.activity = [];

  const primaryPaths = ctx.getPersistencePaths();
  if (!primaryPaths) return;

  let readPaths = primaryPaths;
  let shouldMigrateLegacy = false;
  if (!fs.existsSync(primaryPaths.stateFile)) {
    const legacyPaths = ctx.getPersistencePaths(LEGACY_CACHE_DIR);
    if (
      ctx.persistDir === DEFAULT_DATA_DIR &&
      legacyPaths &&
      fs.existsSync(legacyPaths.stateFile)
    ) {
      readPaths = legacyPaths;
      shouldMigrateLegacy = true;
    }
  }

  if (!fs.existsSync(readPaths.stateFile)) {
    return;
  }

  ctx.loadingState = true;
  try {
    if (fs.existsSync(readPaths.forecastsFile)) {
      try {
        const rawForecasts = fs.readFileSync(readPaths.forecastsFile, "utf8");
        const parsedForecasts = JSON.parse(rawForecasts) as ProspectiveForecastRecord[];
        if (Array.isArray(parsedForecasts)) {
          ctx.forecasts = new Map(
            parsedForecasts
              .filter((f) => f && typeof f.id === "string")
              .map((f) => [f.id, f])
          );
        }
      } catch {
        ctx.forecasts = new Map();
      }
    }

    if (fs.existsSync(readPaths.seriesFile)) {
      try {
        const rawSeries = fs.readFileSync(readPaths.seriesFile, "utf8");
        const parsedSeries = JSON.parse(rawSeries) as Record<string, TimeSeriesPoint[]>;
        if (parsedSeries && typeof parsedSeries === "object") {
          ctx.seriesByNode = new Map(
            Object.entries(parsedSeries).filter(([, v]) => Array.isArray(v) && v.length > 0)
          );
        }
      } catch {
        ctx.seriesByNode = new Map();
      }
    }

    if (fs.existsSync(readPaths.multiscaleFile)) {
      try {
        const rawMs = fs.readFileSync(readPaths.multiscaleFile, "utf8");
        const parsedMs = JSON.parse(rawMs) as Record<
          string,
          Partial<Record<TemporalBucket, TimeSeriesPoint[]>>
        >;
        if (parsedMs && typeof parsedMs === "object") {
          const cleaned = new Map<
            string,
            Partial<Record<TemporalBucket, TimeSeriesPoint[]>>
          >();
          for (const [uuid, scalesObj] of Object.entries(parsedMs)) {
            if (!scalesObj || typeof scalesObj !== "object" || FORBIDDEN_PATH_SEGMENTS.has(uuid)) {
              continue;
            }
            const entry: Partial<Record<TemporalBucket, TimeSeriesPoint[]>> = {};
            for (const bucket of ["day", "month", "year"] as const) {
              const arr = scalesObj[bucket];
              if (Array.isArray(arr) && arr.length > 0) {
                entry[bucket] = arr;
              }
            }
            if (Object.keys(entry).length > 0) {
              cleaned.set(uuid, entry);
            }
          }
          ctx.multiScaleSeriesByNode = cleaned;
        }
      } catch {
        ctx.multiScaleSeriesByNode = new Map();
      }
    }

    const raw = fs.readFileSync(readPaths.stateFile, "utf8");
    const parsed = JSON.parse(raw) as {
      nodes?: ETGNode[];
      edges?: ETGEdge[];
      activity?: EtgActivityEntry[];
    };
    if (Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
      let migratedLegacySeries = false;
      ctx.nodes = new Map(
        parsed.nodes.map((n) => {
          if (Array.isArray(n.properties?.series) && n.properties.series.length > 0) {
            migratedLegacySeries = true;
          }
          return [
            n.uuid,
            {
              ...n,
              properties: ctx.offloadNodeSeries(n.uuid, n.properties),
            },
          ];
        })
      );
      ctx.edges = new Map(parsed.edges.map((e) => [e.properties.uuid, e]));
      ctx.activity = Array.isArray(parsed.activity) ? parsed.activity.slice(0, 40) : [];
      if (migratedLegacySeries || shouldMigrateLegacy) {
        ctx.persistState();
      }
      return;
    }
  } catch {
    ctx.nodes = new Map();
    ctx.edges = new Map();
    ctx.seriesByNode = new Map();
    ctx.multiScaleSeriesByNode = new Map();
    ctx.forecasts = new Map();
    ctx.activity = [];
  } finally {
    ctx.loadingState = false;
  }
}

export function persistStateOp(ctx: EtgStoreContext): void {
  const paths = ctx.getPersistencePaths();
  if (!paths) return;
  try {
    fs.mkdirSync(paths.dir, { recursive: true });
    const tmpPath = `${paths.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({
        nodes: Array.from(ctx.nodes.values()),
        edges: Array.from(ctx.edges.values()),
        activity: ctx.activity.slice(0, 40),
      }),
      "utf8"
    );
    fs.renameSync(tmpPath, paths.stateFile);

    if (ctx.seriesByNode.size > 0) {
      const seriesTmpPath = `${paths.seriesFile}.${process.pid}.tmp`;
      fs.writeFileSync(
        seriesTmpPath,
        JSON.stringify(Object.fromEntries(ctx.seriesByNode.entries())),
        "utf8"
      );
      fs.renameSync(seriesTmpPath, paths.seriesFile);
    } else if (fs.existsSync(paths.seriesFile)) {
      fs.unlinkSync(paths.seriesFile);
    }

    if (ctx.multiScaleSeriesByNode.size > 0) {
      const msTmpPath = `${paths.multiscaleFile}.${process.pid}.tmp`;
      fs.writeFileSync(
        msTmpPath,
        JSON.stringify(Object.fromEntries(ctx.multiScaleSeriesByNode.entries())),
        "utf8"
      );
      fs.renameSync(msTmpPath, paths.multiscaleFile);
    } else if (fs.existsSync(paths.multiscaleFile)) {
      fs.unlinkSync(paths.multiscaleFile);
    }

    if (ctx.forecasts.size > 0) {
      const forecastTmpPath = `${paths.forecastsFile}.${process.pid}.tmp`;
      fs.writeFileSync(
        forecastTmpPath,
        JSON.stringify(Array.from(ctx.forecasts.values())),
        "utf8"
      );
      fs.renameSync(forecastTmpPath, paths.forecastsFile);
    } else if (fs.existsSync(paths.forecastsFile)) {
      fs.unlinkSync(paths.forecastsFile);
    }
  } catch {
    // Non-fatal in read-only filesystems
  }
}

export function clearGraphOp(ctx: EtgStoreContext, notify = true): EtgGraphSnapshot {
  ctx.nodes = new Map();
  ctx.edges = new Map();
  ctx.seriesByNode = new Map();
  ctx.multiScaleSeriesByNode = new Map();
  ctx.forecasts = new Map();
  ctx.activity = [];
  const paths = ctx.getPersistencePaths();
  if (paths) {
    try {
      if (fs.existsSync(paths.stateFile)) fs.unlinkSync(paths.stateFile);
      if (fs.existsSync(paths.seriesFile)) fs.unlinkSync(paths.seriesFile);
      if (fs.existsSync(paths.multiscaleFile)) fs.unlinkSync(paths.multiscaleFile);
      if (fs.existsSync(paths.forecastsFile)) fs.unlinkSync(paths.forecastsFile);
    } catch {
      // Ignore cleanup errors
    }
  }
  if (notify) {
    const act = ctx.pushActivity({
      kind: "discovery",
      summary: "Cleared Earth Trend Graph to 0 nodes (empty unseeded state).",
    });
    ctx.emitUpdate(act);
  }
  return ctx.getSnapshot();
}

export function exportWorkspaceBundleOp(ctx: EtgStoreContext): ETGWorkspaceBundle {
  return {
    schema_version: "etg-workspace-v1",
    exported_at: new Date().toISOString(),
    nodes: Array.from(ctx.nodes.values()).map((n) => ({
      ...n,
      properties: { ...n.properties },
    })),
    edges: Array.from(ctx.edges.values()).map((e) => ({
      ...e,
      properties: { ...e.properties },
    })),
    series_by_node: Object.fromEntries(
      Array.from(ctx.seriesByNode.entries()).map(([k, v]) => [k, [...v]])
    ),
    ...(ctx.multiScaleSeriesByNode.size > 0
      ? {
          multi_scale_series_by_node: Object.fromEntries(
            Array.from(ctx.multiScaleSeriesByNode.entries()).map(([uuid, scalesObj]) => [
              uuid,
              {
                ...(scalesObj.day ? { day: [...scalesObj.day] } : {}),
                ...(scalesObj.month ? { month: [...scalesObj.month] } : {}),
                ...(scalesObj.year ? { year: [...scalesObj.year] } : {}),
              },
            ])
          ),
        }
      : {}),
    activity: [...ctx.activity],
    prospective_forecasts: Array.from(ctx.forecasts.values()),
  };
}

export function importWorkspaceBundleOp(
  ctx: EtgStoreContext,
  rawBundle: Partial<ETGWorkspaceBundle>,
  options?: { merge?: boolean }
): {
  importedNodes: number;
  importedEdges: number;
  snapshot: EtgGraphSnapshot;
} {
  if (!rawBundle || typeof rawBundle !== "object" || !Array.isArray(rawBundle.nodes) || !Array.isArray(rawBundle.edges)) {
    throw new Error("Invalid workspace bundle: expected nodes[] and edges[] arrays.");
  }

  // Validate all labels, lengths, coords, and edge invariants before mutating store state
  for (const rawNode of rawBundle.nodes) {
    if (!rawNode || typeof rawNode !== "object" || typeof rawNode.uuid !== "string" || !rawNode.uuid.trim()) {
      throw new Error("Invalid node in workspace bundle: missing uuid.");
    }
    if (FORBIDDEN_PATH_SEGMENTS.has(rawNode.uuid.trim()) || rawNode.uuid.trim().length > 200) {
      throw new Error(`Invalid node UUID "${rawNode.uuid}" in workspace bundle.`);
    }
    assertValidEtgLabel(String(rawNode.label ?? ""));
    if (!rawNode.properties || typeof rawNode.properties.name !== "string") {
      throw new Error(`Invalid node "${rawNode.uuid}" properties in workspace bundle.`);
    }
    if (
      rawNode.properties.name.length > 240 ||
      (typeof rawNode.properties.description === "string" && rawNode.properties.description.length > 4000)
    ) {
      throw new Error(`Node "${rawNode.uuid}" exceeds maximum field length in workspace bundle.`);
    }
    if (
      rawNode.properties.lat !== undefined &&
      (typeof rawNode.properties.lat !== "number" ||
        !Number.isFinite(rawNode.properties.lat) ||
        rawNode.properties.lat < -90 ||
        rawNode.properties.lat > 90)
    ) {
      throw new Error(`Invalid latitude on node "${rawNode.uuid}" in workspace bundle.`);
    }
    if (
      rawNode.properties.lng !== undefined &&
      (typeof rawNode.properties.lng !== "number" ||
        !Number.isFinite(rawNode.properties.lng) ||
        rawNode.properties.lng < -180 ||
        rawNode.properties.lng > 180)
    ) {
      throw new Error(`Invalid longitude on node "${rawNode.uuid}" in workspace bundle.`);
    }
  }
  for (const rawEdge of rawBundle.edges) {
    if (rawEdge && typeof rawEdge === "object" && rawEdge.source_uuid === rawEdge.target_uuid) {
      throw new Error("Workspace bundle contains a disallowed self-loop edge.");
    }
  }

  if (!options?.merge) {
    ctx.nodes = new Map();
    ctx.edges = new Map();
    ctx.seriesByNode = new Map();
    ctx.multiScaleSeriesByNode = new Map();
    ctx.forecasts = new Map();
    ctx.activity = [];
  }

  if (Array.isArray(rawBundle.prospective_forecasts)) {
    for (const f of rawBundle.prospective_forecasts) {
      if (f && typeof f.id === "string" && !FORBIDDEN_PATH_SEGMENTS.has(f.id)) {
        ctx.forecasts.set(f.id, f);
      }
    }
  }

  const bundleSeries =
    rawBundle.series_by_node && typeof rawBundle.series_by_node === "object"
      ? rawBundle.series_by_node
      : {};

  let importedNodes = 0;
  for (const rawNode of rawBundle.nodes) {
    const cleanUuid = rawNode.uuid.trim();
    if (FORBIDDEN_PATH_SEGMENTS.has(cleanUuid)) continue;
    const inlineSeries = Array.isArray(rawNode.properties.series) ? rawNode.properties.series : undefined;
    const offloadedSeries = Array.isArray(bundleSeries[cleanUuid]) ? bundleSeries[cleanUuid] : undefined;
    const combinedSeries = offloadedSeries && offloadedSeries.length > 0 ? offloadedSeries : inlineSeries;

    const nodeProps = ctx.offloadNodeSeries(cleanUuid, {
      ...rawNode.properties,
      series: combinedSeries,
    });

    ctx.nodes.set(cleanUuid, {
      uuid: cleanUuid,
      label: assertValidEtgLabel(rawNode.label),
      is_provisional: rawNode.is_provisional,
      properties: nodeProps,
    });
    importedNodes += 1;
  }

  if (
    rawBundle.multi_scale_series_by_node &&
    typeof rawBundle.multi_scale_series_by_node === "object"
  ) {
    for (const [uuid, scalesObj] of Object.entries(rawBundle.multi_scale_series_by_node)) {
      if (!scalesObj || typeof scalesObj !== "object" || FORBIDDEN_PATH_SEGMENTS.has(uuid)) {
        continue;
      }
      if (!ctx.nodes.has(uuid)) continue;
      for (const scale of ["day", "month", "year"] as const) {
        const arr = scalesObj[scale];
        if (Array.isArray(arr) && arr.length > 0) {
          ctx.setNodeMultiScaleSeries(uuid, scale, arr, true);
        }
      }
    }
  }

  let importedEdges = 0;
  for (const rawEdge of rawBundle.edges) {
    if (
      !rawEdge ||
      typeof rawEdge !== "object" ||
      typeof rawEdge.source_uuid !== "string" ||
      typeof rawEdge.target_uuid !== "string" ||
      !rawEdge.properties ||
      typeof rawEdge.properties.uuid !== "string"
    ) {
      continue;
    }
    if (!ctx.nodes.has(rawEdge.source_uuid) || !ctx.nodes.has(rawEdge.target_uuid)) {
      continue;
    }
    const edgeUuid = rawEdge.properties.uuid.trim();
    if (!edgeUuid || FORBIDDEN_PATH_SEGMENTS.has(edgeUuid)) continue;

    if (
      rawEdge.type === "supersedes" &&
      ctx.wouldCreateSupersedesCycle(rawEdge.source_uuid, rawEdge.target_uuid)
    ) {
      continue;
    }

    ctx.edges.set(edgeUuid, {
      source_uuid: rawEdge.source_uuid,
      target_uuid: rawEdge.target_uuid,
      type: rawEdge.type,
      properties: {
        ...rawEdge.properties,
        uuid: edgeUuid,
      },
    });
    importedEdges += 1;
  }

  // Re-evaluate multi-source corroboration for Insight nodes when corroboration rules exist
  if (ctx.nodes.has("rule-corroboration")) {
    for (const n of ctx.nodes.values()) {
      if (n.label === "Insight") {
        ctx.evaluateCorroboration(n.uuid, false);
      }
    }
  }

  const act = ctx.pushActivity({
    kind: "dataset",
    summary: `Imported ETG workspace bundle (${importedNodes} node${importedNodes === 1 ? "" : "s"}, ${importedEdges} connection${importedEdges === 1 ? "" : "s"}, mode=${options?.merge ? "merge" : "replace"}).`,
  });
  ctx.emitUpdate(act);

  return {
    importedNodes,
    importedEdges,
    snapshot: ctx.getSnapshot(),
  };
}
