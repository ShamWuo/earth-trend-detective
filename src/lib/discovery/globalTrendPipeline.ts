import crypto from "node:crypto";
import {
  fetchCsaSwotAndRcmMetadata,
  fetchGeocaCanadianSeries,
  fetchKnmiClimateIndices,
  fetchKnmiMonthlyClimateIndices,
  fetchNoaaCdoGlobalStations,
  fetchUsgsCoastalPlumeDischarge,
} from "@/lib/agencies/challengeSourcesClient";
import { getEtgStore, haversineKm, type EtgGraphSnapshot } from "@/lib/graph/etgStore";
import { classifyEarthRegionByCoord } from "@/lib/graph/regionalSubgraph";
import {
  buildGistempClimatologicalFallback,
  buildNoaaCo2ClimatologicalFallback,
  buildNsidcSeaIceClimatologicalFallback,
  fetchNasaGistempZonalSeriesWithFallback,
  fetchNoaaGlobalCo2SeriesWithFallback,
  fetchNsidcArcticSeaIceSeriesWithFallback,
} from "@/lib/nasa/gistempAndCo2Client";
import { fetchLiveEonetSignals } from "@/lib/nasa/eonetClient";
import { fetchMultiParamNasaPower } from "@/lib/nasa/nasaPowerClient";
import {
  analyzeTimeSeries,
  benjaminiHochbergAdjust,
  compareRegionalSeries,
} from "@/lib/stats/trendEngine";
import type {
  CrossRegionComparison,
  ETGDatasetId,
  ETGNode,
  TimeSeriesPoint,
  TrendAnalysisSummary,
} from "@/types/etg";

type EtgStoreInstance = ReturnType<typeof getEtgStore>;

export interface GlobalDiscoverySummary {
  sourcesQueried: string[];
  gistempZonesIngested: number;
  eonetEventsIngested: number;
  nasaPowerSeriesAnalyzed: number;
  noaaCdoStationsIngested: number;
  knmiIndicesIngested: number;
  csaGeocaSeriesIngested: number;
  swotGranulesLinked: number;
  insightsCreated: number;
  corroboratedInsights: number;
  beliefRevisionsCreated: number;
  oppositeDipolesWired: number;
  coTrendingTeleconnectionsWired: number;
}

interface SeriesCandidate {
  nodeUuid: string;
  name: string;
  region: string;
  lat: number;
  lng: number;
  dataset: ETGDatasetId;
  summary: TrendAnalysisSummary;
  series: TimeSeriesPoint[];
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        const value = await fn(items[idx]);
        results[idx] = { status: "fulfilled", value };
      } catch (reason) {
        results[idx] = { status: "rejected", reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, () =>
    worker()
  );
  await Promise.all(workers);
  return results;
}

function findMatchingGistempBandId(lat: number): string {
  if (lat >= 64) return "64n-90n";
  if (lat >= 44) return "44n-64n";
  if (lat >= 24) return "24n-44n";
  if (lat >= 0) return "equ-24n";
  if (lat >= -24) return "24s-equ";
  if (lat >= -44) return "44s-24s";
  if (lat >= -64) return "64s-44s";
  return "90s-64s";
}

function formatSlope(slope: number, unit: string): string {
  return `${slope >= 0 ? "+" : ""}${slope.toFixed(4)} ${unit}`;
}

export async function discoverGlobalEarthTrends(
  store: EtgStoreInstance,
  options?: { clearExisting?: boolean; maxEonetSites?: number }
): Promise<{
  summary: GlobalDiscoverySummary;
  snapshot: EtgGraphSnapshot;
}> {
  if (options?.clearExisting) {
    store.clearGraph(false);
  }
  store.ensureGovernanceRules();

  const now = new Date().toISOString();

  // 1. Upsert canonical observation producer Concept nodes
  store.createNode({
    uuid: "concept-nasa-gistemp",
    label: "Concept",
    is_provisional: false,
    silent: true,
    properties: {
      name: "NASA GISS GISTEMP v4 Zonal Network",
      concept_name: "NASA GISS GISTEMP v4",
      description:
        "NASA Goddard Institute for Space Studies surface temperature anomaly record (1880–2025) segmented across 8 global latitude bands.",
      status: "Active",
      importance: 9,
      lat: 40.81,
      lng: -73.96,
      region: "Global Zonal Network",
      dataset: "nasa_power",
      producer_type: "research_station",
      source_system: "NASA GISTEMP v4",
      source_url: "https://data.giss.nasa.gov/gistemp/tabledata_v4/ZonAnn.Ts+dSST.csv",
      observed_at: "2024-01-01T00:00:00.000Z",
      created_at: now,
    },
  });

  store.createNode({
    uuid: "concept-noaa-gml-co2",
    label: "Concept",
    is_provisional: false,
    silent: true,
    properties: {
      name: "NOAA GML Global Marine CO₂ Network",
      concept_name: "NOAA GML CO₂",
      description:
        "NOAA Global Monitoring Laboratory globally averaged marine surface atmospheric carbon dioxide concentration record (ppm).",
      status: "Active",
      importance: 9,
      lat: 19.54,
      lng: -155.58,
      region: "Mauna Loa / Global Marine",
      dataset: "air_quality",
      producer_type: "research_station",
      source_system: "NOAA GML",
      source_url: "https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_annmean_gl.txt",
      observed_at: "2024-01-01T00:00:00.000Z",
      created_at: now,
    },
  });

  store.createNode({
    uuid: "concept-nasa-power-merra2",
    label: "Concept",
    is_provisional: false,
    silent: true,
    properties: {
      name: "NASA POWER MERRA-2 Reanalysis Grid",
      concept_name: "NASA POWER MERRA-2",
      description:
        "NASA Prediction Of Worldwide Energy Resources 30-year monthly meteorological & hydrological time-series (T2M, TS, PRECTOTCORR).",
      status: "Active",
      importance: 9,
      lat: 37.09,
      lng: -76.38,
      region: "Global Reanalysis Grid",
      dataset: "nasa_power",
      producer_type: "nasa_satellite",
      source_system: "NASA POWER MERRA-2",
      source_url: "https://power.larc.nasa.gov/",
      observed_at: "2024-01-01T00:00:00.000Z",
      created_at: now,
    },
  });

  store.createNode({
    uuid: "concept-nasa-eonet",
    label: "Concept",
    is_provisional: false,
    silent: true,
    properties: {
      name: "NASA EONET v3 Orbital Event Tracker",
      concept_name: "NASA EONET v3",
      description:
        "NASA Earth Observatory Natural Event Tracker streaming active wildfires, storms, polar ice events, floods, dust plumes, and volcanoes.",
      status: "Active",
      importance: 9,
      lat: 38.99,
      lng: -76.85,
      region: "Global Orbital Feed",
      dataset: "wildfire",
      producer_type: "nasa_satellite",
      source_system: "NASA EONET v3",
      source_url: "https://eonet.gsfc.nasa.gov/api/v3/events",
      observed_at: now,
      created_at: now,
    },
  });

  store.createNode({
    uuid: "concept-noaa-nsidc-seaice",
    label: "Concept",
    is_provisional: false,
    silent: true,
    properties: {
      name: "NOAA/NSIDC Passive Microwave Sea Ice Network",
      concept_name: "NOAA/NSIDC Sea Ice v4",
      description:
        "NOAA/NSIDC Sea Ice Index v4.0 satellite passive-microwave record of September Arctic sea ice minimum extent (million km²).",
      status: "Active",
      importance: 9,
      lat: 82.5,
      lng: -135.0,
      region: "Beaufort / Central Arctic Pack Ice",
      dataset: "ocean_temp",
      producer_type: "nasa_satellite",
      source_system: "NOAA/NSIDC G02135 v4.0",
      source_url: "https://noaadata.apps.nsidc.org/NOAA/G02135/north/monthly/data/N_09_extent_v4.0.csv",
      observed_at: "2024-09-15T00:00:00.000Z",
      created_at: now,
    },
  });

  // 2. Fetch live upstream NASA, NOAA CDO, NSIDC, KNMI Climate Explorer, CSA/Geo.ca, SWOT/RCM/AppEEARS, and USGS/SeaWiFS streams concurrently
  const maxEonetSites = options?.maxEonetSites ?? 7;
  const [
    gistempSettled,
    noaaSettled,
    nsidcSettled,
    eonetSettled,
    noaaCdoSettled,
    knmiSettled,
    knmiMonthlySettled,
    geocaSettled,
    usgsPlumeSettled,
    orbitalSettled,
  ] = await Promise.allSettled([
    fetchNasaGistempZonalSeriesWithFallback(1995, 2025),
    fetchNoaaGlobalCo2SeriesWithFallback(1995, 2025),
    fetchNsidcArcticSeaIceSeriesWithFallback(1995, 2025),
    fetchLiveEonetSignals(maxEonetSites),
    fetchNoaaCdoGlobalStations(1995, 2025),
    fetchKnmiClimateIndices(1995, 2025),
    fetchKnmiMonthlyClimateIndices(1995, 2025),
    fetchGeocaCanadianSeries(1995, 2025),
    fetchUsgsCoastalPlumeDischarge(1995, 2025),
    fetchCsaSwotAndRcmMetadata(),
  ]);

  const gistempFull =
    gistempSettled.status === "fulfilled"
      ? gistempSettled.value
      : { ...buildGistempClimatologicalFallback(1995, 2025), provenanceMode: "climatological_fallback" as const };
  const noaaRes =
    noaaSettled.status === "fulfilled"
      ? noaaSettled.value
      : { ...buildNoaaCo2ClimatologicalFallback(1995, 2025), provenanceMode: "climatological_fallback" as const };
  const nsidcRes =
    nsidcSettled.status === "fulfilled"
      ? nsidcSettled.value
      : { ...buildNsidcSeaIceClimatologicalFallback(1995, 2025), provenanceMode: "climatological_fallback" as const };
  const eonetRes =
    eonetSettled.status === "fulfilled"
      ? eonetSettled.value
      : {
          provenance: "NASA EONET v3 (Baseline Fallback)" as const,
          provenanceMode: "climatological_fallback" as const,
          signals: [],
        };

  const noaaCdoRecords = noaaCdoSettled.status === "fulfilled" ? noaaCdoSettled.value : [];
  const knmiRecords = knmiSettled.status === "fulfilled" ? knmiSettled.value : [];
  const knmiMonthlyById = new Map(
    (knmiMonthlySettled.status === "fulfilled" ? knmiMonthlySettled.value : []).map((r) => [
      r.id,
      r,
    ])
  );
  const geocaRecords = geocaSettled.status === "fulfilled" ? geocaSettled.value : [];
  const usgsPlumeRecord = usgsPlumeSettled.status === "fulfilled" ? usgsPlumeSettled.value : null;
  const orbitalMeta =
    orbitalSettled.status === "fulfilled"
      ? orbitalSettled.value
      : { passes: [], appeearsProductCount: 0, rcmCollectionCount: 0, seawifsCollectionTitle: null };

  const gistempEarly = {
    sourceUrl: gistempFull.sourceUrl,
    globalSeries: gistempFull.globalSeries.filter((p) => p.t <= 2010),
    zones: gistempFull.zones.map((z) => ({
      ...z,
      points: z.points.filter((p) => p.t <= 2010),
    })),
  };

  const co2Provenance =
    noaaRes.provenanceMode === "climatological_fallback"
      ? ("NOAA GML CO2 (Climatological Fallback)" as const)
      : ("NOAA GML CO2 (Live)" as const);

  // 3. Record NOAA Global CO2 Signal + Insight
  const co2Summary = analyzeTimeSeries(noaaRes.points, {
    lat: 19.54,
    lng: -155.58,
    dataset: "air_quality",
    parameter: "CO2_GL (NOAA Marine Mean)",
    unit: "ppm",
    slopeUnit: "ppm/yr",
    provenance: co2Provenance,
    provenanceMode: noaaRes.provenanceMode,
  });

  const co2SignalUuid = "signal-noaa-global-co2";
  const latestCo2Year = noaaRes.points[noaaRes.points.length - 1]?.date || "2025";
  store.createNode({
    uuid: co2SignalUuid,
    label: "Signal",
    is_provisional: false,
    silent: true,
    properties: {
      name: `Global Marine Surface CO₂ (${noaaRes.points[0]?.date}–${latestCo2Year})`,
      concept_name: "Global Marine Surface CO₂",
      description: `NOAA GML global marine surface CO₂ rose from ${noaaRes.points[0]?.value.toFixed(2)} ppm (${noaaRes.points[0]?.date}) to ${co2Summary.latestValue.toFixed(2)} ppm (${latestCo2Year}). Mann-Kendall p=${co2Summary.mannKendall.pValue.toExponential(2)}, Theil-Sen slope=${formatSlope(co2Summary.theilSen.slope, "ppm/yr")}.`,
      status: "Active",
      importance: 9,
      lat: 19.54,
      lng: -155.58,
      region: "Global Marine Surface (NOAA GML)",
      dataset: "air_quality",
      producer_type: "research_station",
      source_system: "NOAA GML",
      source_url: noaaRes.sourceUrl,
      parameter: "CO2_GL (NOAA Marine Mean)",
      provenance_source: "NOAA GML CO2 (Live)",
      confidence: 0.99,
      value: Number(co2Summary.latestValue.toFixed(2)),
      unit: "ppm",
      p_value: co2Summary.mannKendall.pValue,
      theil_sen_slope: Number(co2Summary.theilSen.slope.toFixed(4)),
      slope_unit: "ppm/yr",
      series: noaaRes.points,
      observed_at: `${latestCo2Year}-06-01T00:00:00.000Z`,
      created_at: now,
    },
  });

  store.createEdge({
    uuid: "edge-monitors-noaa-co2",
    source_uuid: "concept-noaa-gml-co2",
    target_uuid: co2SignalUuid,
    type: "monitors",
    source_snippet: "NOAA GML Global Marine Surface Reference",
    silent: true,
  });

  const seriesCandidates: SeriesCandidate[] = [
    {
      nodeUuid: co2SignalUuid,
      name: `Global Marine Surface CO₂ (${noaaRes.points[0]?.date}–${latestCo2Year})`,
      region: "Global Marine Surface",
      lat: 19.54,
      lng: -155.58,
      dataset: "air_quality",
      summary: co2Summary,
      series: noaaRes.points,
    },
  ];

  // 3b. Record NOAA/NSIDC September Arctic Sea Ice Extent Signal
  const nsidcProvenance =
    nsidcRes.provenanceMode === "climatological_fallback"
      ? ("NOAA/NSIDC Sea Ice v4 (Climatological Fallback)" as const)
      : ("NOAA/NSIDC Sea Ice v4 (Live)" as const);
  const nsidcSummary = analyzeTimeSeries(nsidcRes.points, {
    lat: 82.5,
    lng: -135.0,
    dataset: "ocean_temp",
    parameter: "SEA_ICE_EXTENT_09 (NSIDC v4.0)",
    unit: "M km²",
    slopeUnit: "M km²/yr",
    provenance: nsidcProvenance,
    provenanceMode: nsidcRes.provenanceMode,
  });

  const nsidcSignalUuid = "signal-nsidc-arctic-seaice";
  const latestIceYear = nsidcRes.points[nsidcRes.points.length - 1]?.date || "2025";
  store.createNode({
    uuid: nsidcSignalUuid,
    label: "Signal",
    is_provisional: false,
    silent: true,
    properties: {
      name: `Arctic September Sea Ice Extent (${nsidcRes.points[0]?.date}–${latestIceYear})`,
      concept_name: "Arctic September Sea Ice Extent",
      description: `NOAA/NSIDC Sea Ice Index v4.0 September Arctic sea ice minimum fell from ${nsidcRes.points[0]?.value.toFixed(2)} M km² (${nsidcRes.points[0]?.date}) to ${nsidcSummary.latestValue.toFixed(2)} M km² (${latestIceYear}). Mann-Kendall p=${nsidcSummary.mannKendall.pValue.toExponential(2)}, Theil-Sen slope=${formatSlope(nsidcSummary.theilSen.slope, "M km²/yr")}.`,
      status: "Active",
      importance: 9,
      lat: 82.5,
      lng: -135.0,
      region: "Beaufort / Central Arctic Pack Ice",
      dataset: "ocean_temp",
      producer_type: "nasa_satellite",
      source_system: "NOAA/NSIDC G02135 v4.0",
      source_url: nsidcRes.sourceUrl,
      parameter: "SEA_ICE_EXTENT_09",
      provenance_source: "NOAA/NSIDC Sea Ice v4 (Live)",
      confidence: 0.98,
      value: Number(nsidcSummary.latestValue.toFixed(2)),
      unit: "M km²",
      p_value: nsidcSummary.mannKendall.pValue,
      theil_sen_slope: Number(nsidcSummary.theilSen.slope.toFixed(4)),
      slope_unit: "M km²/yr",
      series: nsidcRes.points,
      observed_at: `${latestIceYear}-09-15T00:00:00.000Z`,
      created_at: now,
    },
  });

  store.createEdge({
    uuid: "edge-monitors-nsidc-seaice",
    source_uuid: "concept-noaa-nsidc-seaice",
    target_uuid: nsidcSignalUuid,
    type: "monitors",
    source_snippet: "NOAA/NSIDC Sea Ice Index v4.0 September Extent",
    silent: true,
  });

  seriesCandidates.push({
    nodeUuid: nsidcSignalUuid,
    name: `Arctic September Sea Ice Extent (${nsidcRes.points[0]?.date}–${latestIceYear})`,
    region: "Beaufort / Central Arctic Pack Ice",
    lat: 82.5,
    lng: -135.0,
    dataset: "ocean_temp",
    summary: nsidcSummary,
    series: nsidcRes.points,
  });

  // 4. Record all 8 NASA GISTEMP v4 Zonal Signals + Zonal Insights
  let insightsCreated = 0;
  let beliefRevisionsCreated = 0;
  const gistempSignalByBand = new Map<string, { node: ETGNode; summary: TrendAnalysisSummary; points: TimeSeriesPoint[] }>();

  const gistempProvenance =
    gistempFull.provenanceMode === "climatological_fallback"
      ? ("NASA GISTEMP v4 (Climatological Fallback)" as const)
      : ("NASA GISTEMP v4 (Live)" as const);
  for (const zone of gistempFull.zones) {
    const zSummary = analyzeTimeSeries(zone.points, {
      lat: zone.lat,
      lng: zone.lng,
      dataset: zone.dataset,
      parameter: `GISTEMP ${zone.column} (Ts+dSST)`,
      unit: "°C anom",
      slopeUnit: "°C/yr",
      provenance: gistempProvenance,
      provenanceMode: gistempFull.provenanceMode,
    });

    const peakPt = zone.points.reduce(
      (best, cur) => (Math.abs(cur.value) > Math.abs(best.value) ? cur : best),
      zone.points[zone.points.length - 1]
    );
    const sigUuid = `signal-gistemp-${zone.id}`;
    const observedAt = `${peakPt.date}-07-01T00:00:00.000Z`;

    const sigNode = store.createNode({
      uuid: sigUuid,
      label: "Signal",
      is_provisional: false,
      silent: true,
      properties: {
        name: `GISTEMP ${zone.column}: ${zone.regionName}`,
        concept_name: `GISTEMP ${zone.column}`,
        description: `NASA GISTEMP v4 (${zone.points[0]?.date}–${zone.points[zone.points.length - 1]?.date}) temperature anomaly at ${zone.column}: latest ${zSummary.latestValue >= 0 ? "+" : ""}${zSummary.latestValue.toFixed(2)}°C, peak ${peakPt.value >= 0 ? "+" : ""}${peakPt.value.toFixed(2)}°C (${peakPt.date}). Mann-Kendall p=${zSummary.mannKendall.pValue.toFixed(4)}, Theil-Sen ${formatSlope(zSummary.theilSen.slope, "°C/yr")}.`,
        status: "Active",
        importance: zSummary.mannKendall.significant ? 9 : 7,
        lat: zone.lat,
        lng: zone.lng,
        region: zone.regionName,
        dataset: zone.dataset,
        producer_type: "research_station",
        source_system: "NASA GISTEMP v4",
        source_url: gistempFull.sourceUrl,
        parameter: `GISTEMP ${zone.column}`,
        provenance_source: "NASA GISTEMP v4 (Live)",
        confidence: 0.96,
        value: Number(zSummary.latestValue.toFixed(2)),
        unit: "°C anom",
        p_value: zSummary.mannKendall.pValue,
        theil_sen_slope: Number(zSummary.theilSen.slope.toFixed(4)),
        slope_unit: "°C/yr",
        series: zone.points,
        observed_at: observedAt,
        created_at: now,
      },
    });

    store.createEdge({
      uuid: `edge-mon-gistemp-${zone.id}`,
      source_uuid: "concept-nasa-gistemp",
      target_uuid: sigUuid,
      type: "monitors",
      source_snippet: `NASA GISS zonal band ${zone.column}`,
      silent: true,
    });

    gistempSignalByBand.set(zone.id, { node: sigNode, summary: zSummary, points: zone.points });
  }

  // Empirical Belief Revision on Arctic Polar Amplification (1995-2010 early window vs 1995-2025 full record)
  const arcticFull = gistempSignalByBand.get("64n-90n");
  const arcticEarlyZone = gistempEarly.zones.find((z) => z.id === "64n-90n");
  let arcticRevisedUuid: string | null = null;
  if (arcticFull && arcticEarlyZone && arcticEarlyZone.points.length >= 5) {
    const earlySummary = analyzeTimeSeries(arcticEarlyZone.points, {
      lat: arcticEarlyZone.lat,
      lng: arcticEarlyZone.lng,
      dataset: "ocean_temp",
      parameter: "GISTEMP 64N-90N (1995–2010)",
      unit: "°C anom",
      slopeUnit: "°C/yr",
      provenance: "NASA GISTEMP v4 (Live)",
    });

    const priorUuid = "insight-arctic-gistemp-baseline";
    store.createNode({
      uuid: priorUuid,
      label: "Insight",
      is_provisional: false,
      silent: true,
      properties: {
        name: "Arctic Warming Assessment (1995–2010 Window)",
        concept_name: "Arctic Warming (1995–2010)",
        description: `Initial 1995–2010 NASA GISTEMP 64N–90N assessment measured Theil-Sen slope ${formatSlope(earlySummary.theilSen.slope, "°C/yr")} (p=${earlySummary.mannKendall.pValue.toFixed(4)}).`,
        status: "Active",
        importance: 7,
        lat: arcticEarlyZone.lat,
        lng: arcticEarlyZone.lng,
        region: arcticEarlyZone.regionName,
        dataset: "ocean_temp",
        producer_type: "research_station",
        source_system: "NASA GISTEMP v4",
        source_url: gistempFull.sourceUrl,
        parameter: "GISTEMP 64N-90N",
        value: earlySummary.latestValue,
        unit: "°C anom",
        provenance_source: "NASA GISTEMP v4 (Live)",
        p_value: earlySummary.mannKendall.pValue,
        theil_sen_slope: Number(earlySummary.theilSen.slope.toFixed(4)),
        slope_unit: "°C/yr",
        series: arcticEarlyZone.points,
        observed_at: "2010-12-01T00:00:00.000Z",
        created_at: "2010-12-01T00:00:00.000Z",
      },
    });
    insightsCreated++;

    const revision = store.reviseBelief({
      priorNodeUuid: priorUuid,
      newName: `Arctic Polar Amplification Confirmed (${arcticFull.points[0]?.date}–${arcticFull.points[arcticFull.points.length - 1]?.date})`,
      newDescription: `Updated 31-year NASA GISTEMP 64N–90N record reaches ${arcticFull.summary.latestValue >= 0 ? "+" : ""}${arcticFull.summary.latestValue.toFixed(2)}°C anomaly with Theil-Sen slope ${formatSlope(arcticFull.summary.theilSen.slope, "°C/yr")} (Mann-Kendall p=${arcticFull.summary.mannKendall.pValue.toExponential(2)}), corroborated against NOAA global CO₂ forcing.`,
      rationale: `Extending GISTEMP 64N–90N from 1995–2010 (slope ${formatSlope(earlySummary.theilSen.slope, "°C/yr")}, p=${earlySummary.mannKendall.pValue.toFixed(4)}) through 2025 yields sustained high-latitude trend (${formatSlope(arcticFull.summary.theilSen.slope, "°C/yr")}, p=${arcticFull.summary.mannKendall.pValue.toExponential(2)}).`,
      dataset: "ocean_temp",
      confidence: 0.98,
      p_value: arcticFull.summary.mannKendall.pValue,
      theil_sen_slope: Number(arcticFull.summary.theilSen.slope.toFixed(4)),
      series: arcticFull.points,
      observed_at: arcticFull.node.properties.observed_at,
      silent: true,
    });
    beliefRevisionsCreated++;
    insightsCreated++;
    arcticRevisedUuid = revision.revisedNode.uuid;

    store.createEdge({
      uuid: `edge-supp-gistemp-arctic`,
      source_uuid: arcticFull.node.uuid,
      target_uuid: revision.revisedNode.uuid,
      type: "supports",
      source_snippet: "NASA GISTEMP v4 64N-90N zonal record",
      silent: true,
    });

    const co2VsArctic = compareRegionalSeries(noaaRes.points, arcticFull.points, {
      latA: 19.5362,
      lngA: -155.5763,
      datasetA: "air_quality",
      latB: arcticFull.node.properties.lat,
      lngB: arcticFull.node.properties.lng,
      datasetB: "ocean_temp",
    });
    if (co2VsArctic.pearsonR >= 0.65 && co2VsArctic.pValue < 0.05) {
      store.createEdge({
        uuid: `edge-corr-co2-arctic`,
        source_uuid: co2SignalUuid,
        target_uuid: revision.revisedNode.uuid,
        type: "corroborates",
        correlation_r: co2VsArctic.pearsonR,
        detrended_r: co2VsArctic.detrendedR,
        optimal_lag_steps: co2VsArctic.optimalLagSteps,
        lag_unit: co2VsArctic.lagUnit,
        mechanism: "Polar Amplification Cascade",
        amplification_ratio: co2VsArctic.slopeRatio,
        shared_shift_year: co2VsArctic.sharedRegimeShiftYear ?? undefined,
        cross_scale: true,
        source_snippet: `NOAA CO₂ vs Arctic GISTEMP r=${co2VsArctic.pearsonR.toFixed(2)}`,
        rationale: `Radiative CO₂ rise strongly co-varies with 64N–90N warming (r=${co2VsArctic.pearsonR.toFixed(2)}, r*=${co2VsArctic.detrendedR.toFixed(2)}, p=${co2VsArctic.pValue.toExponential(2)}).`,
        silent: true,
      });
    }

    const iceVsArctic = compareRegionalSeries(arcticFull.points, nsidcRes.points, {
      latA: arcticFull.node.properties.lat,
      lngA: arcticFull.node.properties.lng,
      datasetA: "ocean_temp",
      latB: 82.5,
      lngB: -135.0,
      datasetB: "ocean_temp",
    });
    if (iceVsArctic.pearsonR <= -0.5 && iceVsArctic.pValue < 0.05) {
      store.createEdge({
        uuid: `edge-corr-nsidc-arctic`,
        source_uuid: nsidcSignalUuid,
        target_uuid: revision.revisedNode.uuid,
        type: "corroborates",
        correlation_r: iceVsArctic.pearsonR,
        detrended_r: iceVsArctic.detrendedR,
        optimal_lag_steps: -iceVsArctic.optimalLagSteps,
        lag_unit: iceVsArctic.lagUnit,
        mechanism: "Polar Amplification Cascade",
        amplification_ratio:
          Math.abs(iceVsArctic.slopeRatio) > 1e-9 ? 1 / iceVsArctic.slopeRatio : 0,
        shared_shift_year: iceVsArctic.sharedRegimeShiftYear ?? undefined,
        cross_scale: true,
        source_snippet: `NOAA/NSIDC Sea Ice vs Arctic GISTEMP r=${iceVsArctic.pearsonR.toFixed(2)}`,
        rationale: `Declining Arctic September sea ice albedo mirrors 64N–90N thermal amplification (r=${iceVsArctic.pearsonR.toFixed(2)}, r*=${iceVsArctic.detrendedR.toFixed(2)}, p=${iceVsArctic.pValue.toExponential(2)}).`,
        silent: true,
      });
    }
    store.evaluateCorroboration(revision.revisedNode.uuid, false);

    if (arcticFull.summary.mannKendall.significant) {
      store.createEdge({
        uuid: `edge-mk-${revision.revisedNode.uuid}`,
        source_uuid: "rule-mann-kendall",
        target_uuid: revision.revisedNode.uuid,
        type: "verified_by",
        source_snippet: `Mann-Kendall p=${arcticFull.summary.mannKendall.pValue.toExponential(2)}`,
        silent: true,
      });
    }

    seriesCandidates.push({
      nodeUuid: revision.revisedNode.uuid,
      name: revision.revisedNode.properties.name,
      region: "Arctic (64°N–90°N)",
      lat: arcticFull.node.properties.lat!,
      lng: arcticFull.node.properties.lng!,
      dataset: "ocean_temp",
      summary: arcticFull.summary,
      series: arcticFull.points,
    });
  }

  // Register remaining significant GISTEMP zones as candidate nodes (preferring Sub-Antarctic / Antarctic / Mid-Latitudes for global balance)
  for (const [bandId, entry] of gistempSignalByBand.entries()) {
    if (bandId === "64n-90n") continue;
    seriesCandidates.push({
      nodeUuid: entry.node.uuid,
      name: entry.node.properties.name,
      region: entry.node.properties.region || bandId,
      lat: entry.node.properties.lat!,
      lng: entry.node.properties.lng!,
      dataset: entry.node.properties.dataset || "nasa_power",
      summary: entry.summary,
      series: entry.points,
    });
  }

  // 5. Ingest live NASA EONET events and query NASA POWER MERRA-2 (1995-2025) at each event coordinate
  const eonetSignals = eonetRes.signals;
  for (const evSig of eonetSignals) {
    store.createNode({
      ...evSig,
      properties: {
        ...evSig.properties,
        temporal_scale: evSig.properties.temporal_scale ?? "impulse",
        event_intensity: evSig.properties.event_intensity ?? 1.0,
        event_decay_days: evSig.properties.event_decay_days ?? 14,
      },
      silent: true,
    });
    store.createEdge({
      uuid: `edge-eonet-mon-${evSig.uuid}`,
      source_uuid: "concept-nasa-eonet",
      target_uuid: evSig.uuid,
      type: "monitors",
      source_snippet: "Live NASA EONET v3 event",
      silent: true,
    });
  }

  const powerResults = await runWithConcurrency(eonetSignals, 4, async (evSig) => {
    const lat = evSig.properties.lat!;
    const lng = evSig.properties.lng!;
    const multi = await fetchMultiParamNasaPower(lat, lng, 1995, 2025);
    return { evSig, multi };
  });

  let nasaPowerSeriesAnalyzed = 0;

  for (const result of powerResults) {
    if (result.status !== "fulfilled") continue;
    const { evSig, multi } = result.value;
    const lat = evSig.properties.lat!;
    const lng = evSig.properties.lng!;
    const siteRegion = evSig.properties.region || classifyEarthRegionByCoord(lat, lng).label;

    // Analyze primary thermal series (skin temp TS for ocean/ice, T2M air temp for land events)
    const isOceanOrIce = evSig.properties.dataset === "ocean_temp";
    const thermalSeries = isOceanOrIce && multi.ts.length >= 5 ? multi.ts : multi.t2m;
    const precipSeries = multi.precip;
    const thermalDatasetUsed: ETGDatasetId = isOceanOrIce ? "ocean_temp" : "nasa_power";
    let thermalNodeUuid: string | null = null;
    let hydroNodeUuid: string | null = null;
    let rhNodeUuid: string | null = null;

    const bandId = findMatchingGistempBandId(lat);
    const matchingBand = gistempSignalByBand.get(bandId);

    if (thermalSeries.length >= 5) {
      nasaPowerSeriesAnalyzed++;
      const thermalDataset: ETGDatasetId = isOceanOrIce ? "ocean_temp" : "nasa_power";
      const thermalParam = isOceanOrIce ? "TS (Skin Temp)" : "T2M (Surface Air Temp)";
      const tSummary = analyzeTimeSeries(thermalSeries, {
        lat,
        lng,
        dataset: thermalDataset,
        parameter: thermalParam,
        unit: "°C",
        slopeUnit: "°C/yr",
        provenance: "NASA POWER MERRA-2 (Live)",
      });

      const sigId = `signal-power-t-${evSig.uuid.replace("signal-eonet-", "")}`;
      store.createNode({
        uuid: sigId,
        label: "Signal",
        is_provisional: false,
        silent: true,
        properties: {
          name: `MERRA-2 ${isOceanOrIce ? "Skin Temp" : "Air Temp"} (${evSig.properties.name.slice(0, 32)})`,
          concept_name: `MERRA-2 Thermal @ ${lat.toFixed(1)}°, ${lng.toFixed(1)}°`,
          description: `NASA POWER MERRA-2 31-year (${thermalSeries[0]?.date}–${thermalSeries[thermalSeries.length - 1]?.date}) ${thermalParam} at (${lat.toFixed(2)}°, ${lng.toFixed(2)}°): ${tSummary.verdict}, slope ${formatSlope(tSummary.theilSen.slope, "°C/yr")}, Mann-Kendall p=${tSummary.mannKendall.pValue.toFixed(4)}.`,
          status: "Active",
          importance: tSummary.mannKendall.significant ? 8 : 6,
          lat,
          lng,
          region: siteRegion,
          dataset: thermalDataset,
          producer_type: "nasa_satellite",
          source_system: "NASA POWER MERRA-2",
          source_url: multi.sourceUrl,
          parameter: thermalParam,
          provenance_source: "NASA POWER MERRA-2 (Live)",
          value: Number(tSummary.latestValue.toFixed(2)),
          unit: "°C",
          p_value: tSummary.mannKendall.pValue,
          theil_sen_slope: Number(tSummary.theilSen.slope.toFixed(4)),
          slope_unit: "°C/yr",
          series: thermalSeries,
          observed_at: evSig.properties.observed_at,
          created_at: now,
        },
      });

      store.createEdge({
        uuid: `edge-mon-pwr-${sigId}`,
        source_uuid: "concept-nasa-power-merra2",
        target_uuid: sigId,
        type: "monitors",
        source_snippet: `NASA POWER MERRA-2 (${lat.toFixed(2)}°, ${lng.toFixed(2)}°)`,
        silent: true,
      });

      const monthlyThermal =
        isOceanOrIce && (multi.monthly?.ts?.length ?? 0) >= 12
          ? multi.monthly?.ts
          : multi.monthly?.t2m;
      if (monthlyThermal && monthlyThermal.length >= 12) {
        store.setNodeMultiScaleSeries(sigId, "month", monthlyThermal, true);
      }

      // Promote significant coordinate climate shifts into regional Insight nodes with multi-source corroboration
      if (tSummary.mannKendall.significant) {
        const directionWord = tSummary.theilSen.slope >= 0 ? "Warming" : "Cooling";
        const insightUuid = `insight-pwr-${evSig.uuid.replace("signal-eonet-", "")}`;
        const insightNode = store.createNode({
          uuid: insightUuid,
          label: "Insight",
          is_provisional: true,
          silent: true,
          properties: {
            name: `${evSig.properties.name.slice(0, 34)} · ${directionWord} Trend`,
            concept_name: `${evSig.properties.name} ${directionWord}`,
            description: `Significant ${directionWord.toLowerCase()} detected at (${lat.toFixed(2)}°, ${lng.toFixed(2)}°) across 1995–2025: Theil-Sen slope ${formatSlope(tSummary.theilSen.slope, "°C/yr")} (Mann-Kendall p=${tSummary.mannKendall.pValue.toExponential(2)}), co-located with active NASA EONET event "${evSig.properties.name}".`,
            status: "Provisional",
            importance: 9,
            lat,
            lng,
            region: siteRegion,
            dataset: thermalDataset,
            producer_type: "nasa_satellite",
            source_system: "NASA POWER + EONET Synthesis",
            source_url: multi.sourceUrl,
            parameter: thermalParam,
            provenance_source: "NASA POWER MERRA-2 (Live)",
            confidence: 0.9,
            value: Number(tSummary.latestValue.toFixed(2)),
            unit: "°C",
            p_value: tSummary.mannKendall.pValue,
            theil_sen_slope: Number(tSummary.theilSen.slope.toFixed(4)),
            slope_unit: "°C/yr",
            series: thermalSeries,
            observed_at: evSig.properties.observed_at,
            created_at: now,
          },
        });
        insightsCreated++;

        store.createEdge({
          uuid: `edge-supp-pwr-${insightUuid}`,
          source_uuid: sigId,
          target_uuid: insightUuid,
          type: "supports",
          source_snippet: `MERRA-2 31-yr slope ${formatSlope(tSummary.theilSen.slope, "°C/yr")}`,
          silent: true,
        });

        store.createEdge({
          uuid: `edge-corr-eonet-${insightUuid}`,
          source_uuid: evSig.uuid,
          target_uuid: insightUuid,
          type: "corroborates",
          source_snippet: `Active NASA EONET v3 event at (${lat.toFixed(2)}°, ${lng.toFixed(2)}°)`,
          silent: true,
        });

        if (
          matchingBand &&
          matchingBand.summary.theilSen.slope * tSummary.theilSen.slope > 0
        ) {
          const bandComp = compareRegionalSeries(matchingBand.points, thermalSeries);
          if (bandComp.pearsonR >= 0.35) {
            store.createEdge({
              uuid: `edge-corr-band-${insightUuid}`,
              source_uuid: matchingBand.node.uuid,
              target_uuid: insightUuid,
              type: "corroborates",
              correlation_r: bandComp.pearsonR,
              source_snippet: `NASA GISTEMP ${bandId.toUpperCase()} co-trends (r=${bandComp.pearsonR.toFixed(2)})`,
              silent: true,
            });
          }
        }

        const co2Comp = compareRegionalSeries(noaaRes.points, thermalSeries);
        if (co2Comp.pearsonR >= 0.72 && co2Comp.pValue < 0.01) {
          store.createEdge({
            uuid: `edge-corr-co2-${insightUuid}`,
            source_uuid: co2SignalUuid,
            target_uuid: insightUuid,
            type: "corroborates",
            correlation_r: co2Comp.pearsonR,
            source_snippet: `NOAA GML CO₂ correlation r=${co2Comp.pearsonR.toFixed(2)}`,
            silent: true,
          });
        }

        store.evaluateCorroboration(insightUuid, false);
        store.createEdge({
          uuid: `edge-mk-${insightUuid}`,
          source_uuid: "rule-mann-kendall",
          target_uuid: insightUuid,
          type: "verified_by",
          source_snippet: `Mann-Kendall p=${tSummary.mannKendall.pValue.toExponential(2)}`,
          silent: true,
        });

        thermalNodeUuid = insightNode.uuid;
        seriesCandidates.push({
          nodeUuid: insightNode.uuid,
          name: insightNode.properties.name,
          region: siteRegion,
          lat,
          lng,
          dataset: thermalDataset,
          summary: tSummary,
          series: thermalSeries,
        });
      } else {
        thermalNodeUuid = sigId;
        seriesCandidates.push({
          nodeUuid: sigId,
          name: `MERRA-2 Thermal (${evSig.properties.name.slice(0, 28)})`,
          region: siteRegion,
          lat,
          lng,
          dataset: thermalDataset,
          summary: tSummary,
          series: thermalSeries,
        });
      }
    }

    // Also analyze precipitation (PRECTOTCORR) when it shows a meaningful hydrological trend (drying vs extreme wetting)
    if (precipSeries.length >= 5) {
      nasaPowerSeriesAnalyzed++;
      const pSummary = analyzeTimeSeries(precipSeries, {
        lat,
        lng,
        dataset: "hydrology",
        parameter: "PRECTOTCORR (Precipitation)",
        unit: "mm/day",
        slopeUnit: "mm/d/yr",
        provenance: "NASA POWER MERRA-2 (Live)",
      });

      if (pSummary.mannKendall.pValue < 0.15 && Math.abs(pSummary.theilSen.slope) > 0.005) {
        const hydroLabel = pSummary.theilSen.slope < 0 ? "Drying" : "Wetting";
        const hydroUuid = `signal-power-p-${evSig.uuid.replace("signal-eonet-", "")}`;
        store.createNode({
          uuid: hydroUuid,
          label: "Signal",
          is_provisional: false,
          silent: true,
          properties: {
            name: `MERRA-2 Precip ${hydroLabel} (${evSig.properties.name.slice(0, 28)})`,
            concept_name: `MERRA-2 Hydrology @ ${lat.toFixed(1)}°, ${lng.toFixed(1)}°`,
            description: `NASA POWER PRECTOTCORR (${precipSeries[0]?.date}–${precipSeries[precipSeries.length - 1]?.date}) at (${lat.toFixed(2)}°, ${lng.toFixed(2)}°): slope ${formatSlope(pSummary.theilSen.slope, "mm/d/yr")}, Mann-Kendall p=${pSummary.mannKendall.pValue.toFixed(4)}.`,
            status: "Active",
            importance: pSummary.mannKendall.significant ? 8 : 6,
            lat,
            lng,
            region: siteRegion,
            dataset: "hydrology",
            producer_type: "nasa_satellite",
            source_system: "NASA POWER MERRA-2",
            source_url: multi.sourceUrl,
            parameter: "PRECTOTCORR",
            provenance_source: "NASA POWER MERRA-2 (Live)",
            value: Number(pSummary.latestValue.toFixed(2)),
            unit: "mm/day",
            p_value: pSummary.mannKendall.pValue,
            theil_sen_slope: Number(pSummary.theilSen.slope.toFixed(5)),
            slope_unit: "mm/d/yr",
            series: precipSeries,
            observed_at: evSig.properties.observed_at,
            created_at: now,
          },
        });

        store.createEdge({
          uuid: `edge-mon-hydro-${hydroUuid}`,
          source_uuid: "concept-nasa-power-merra2",
          target_uuid: hydroUuid,
          type: "monitors",
          source_snippet: `NASA POWER PRECTOTCORR (${lat.toFixed(2)}°, ${lng.toFixed(2)}°)`,
          silent: true,
        });

        if (multi.monthly?.precip && multi.monthly.precip.length >= 12) {
          store.setNodeMultiScaleSeries(hydroUuid, "month", multi.monthly.precip, true);
        }

        hydroNodeUuid = hydroUuid;
        seriesCandidates.push({
          nodeUuid: hydroUuid,
          name: `MERRA-2 Precip ${hydroLabel} (${evSig.properties.name.slice(0, 24)})`,
          region: siteRegion,
          lat,
          lng,
          dataset: "hydrology",
          summary: pSummary,
          series: precipSeries,
        });
      }
    }

    // Analyze 2m Relative Humidity (RH2M) for regional atmospheric drying / moistening dipoles
    const rhSeries = multi.rh2m;
    if (rhSeries.length >= 5) {
      nasaPowerSeriesAnalyzed++;
      const rhSummary = analyzeTimeSeries(rhSeries, {
        lat,
        lng,
        dataset: "deforestation",
        parameter: "RH2M (2m Relative Humidity)",
        unit: "% RH",
        slopeUnit: "%/yr",
        provenance: "NASA POWER MERRA-2 (Live)",
      });

      if (rhSummary.mannKendall.pValue < 0.12 && Math.abs(rhSummary.theilSen.slope) > 0.03) {
        const rhLabel = rhSummary.theilSen.slope < 0 ? "Aridity / Drying" : "Moistening";
        const rhUuid = `signal-power-rh-${evSig.uuid.replace("signal-eonet-", "")}`;
        store.createNode({
          uuid: rhUuid,
          label: "Signal",
          is_provisional: false,
          silent: true,
          properties: {
            name: `MERRA-2 RH2M ${rhLabel} (${evSig.properties.name.slice(0, 26)})`,
            concept_name: `MERRA-2 Humidity @ ${lat.toFixed(1)}°, ${lng.toFixed(1)}°`,
            description: `NASA POWER RH2M (${rhSeries[0]?.date}–${rhSeries[rhSeries.length - 1]?.date}) at (${lat.toFixed(2)}°, ${lng.toFixed(2)}°): slope ${formatSlope(rhSummary.theilSen.slope, "%/yr")}, Mann-Kendall p=${rhSummary.mannKendall.pValue.toFixed(4)}.`,
            status: "Active",
            importance: rhSummary.mannKendall.significant ? 8 : 6,
            lat,
            lng,
            region: siteRegion,
            dataset: "deforestation",
            producer_type: "nasa_satellite",
            source_system: "NASA POWER MERRA-2",
            source_url: multi.sourceUrl,
            parameter: "RH2M",
            provenance_source: "NASA POWER MERRA-2 (Live)",
            value: Number(rhSummary.latestValue.toFixed(2)),
            unit: "% RH",
            p_value: rhSummary.mannKendall.pValue,
            theil_sen_slope: Number(rhSummary.theilSen.slope.toFixed(4)),
            slope_unit: "%/yr",
            series: rhSeries,
            observed_at: evSig.properties.observed_at,
            created_at: now,
          },
        });

        store.createEdge({
          uuid: `edge-mon-rh-${rhUuid}`,
          source_uuid: "concept-nasa-power-merra2",
          target_uuid: rhUuid,
          type: "monitors",
          source_snippet: `NASA POWER RH2M (${lat.toFixed(2)}°, ${lng.toFixed(2)}°)`,
          silent: true,
        });

        if (multi.monthly?.rh2m && multi.monthly.rh2m.length >= 12) {
          store.setNodeMultiScaleSeries(rhUuid, "month", multi.monthly.rh2m, true);
        }

        rhNodeUuid = rhUuid;
        seriesCandidates.push({
          nodeUuid: rhUuid,
          name: `MERRA-2 RH2M ${rhLabel} (${evSig.properties.name.slice(0, 22)})`,
          region: siteRegion,
          lat,
          lng,
          dataset: "deforestation",
          summary: rhSummary,
          series: rhSeries,
        });
      }
    }

    // Wire local Compound Hydro-Thermal Feedback edges between co-located MERRA-2 signals
    if (thermalNodeUuid && rhNodeUuid && rhSeries.length >= 5) {
      const heatAridityComp = compareRegionalSeries(thermalSeries, rhSeries, {
        latA: lat,
        lngA: lng,
        datasetA: thermalDatasetUsed,
        latB: lat,
        lngB: lng,
        datasetB: "deforestation",
      });
      if (Math.abs(heatAridityComp.pearsonR) >= 0.4 && heatAridityComp.pValue < 0.05) {
        store.createEdge({
          uuid: `edge-local-rh-${crypto.createHash("sha1").update(`${thermalNodeUuid}:${rhNodeUuid}`).digest("hex").slice(0, 8)}`,
          source_uuid: thermalNodeUuid,
          target_uuid: rhNodeUuid,
          type: heatAridityComp.pearsonR < 0 ? "drives_opposite" : "correlates_with",
          correlation_r: heatAridityComp.pearsonR,
          detrended_r: heatAridityComp.detrendedR,
          optimal_lag_steps: heatAridityComp.optimalLagSteps,
          lag_unit: heatAridityComp.lagUnit,
          mechanism: heatAridityComp.mechanism,
          amplification_ratio: heatAridityComp.slopeRatio,
          shared_shift_year: heatAridityComp.sharedRegimeShiftYear ?? undefined,
          source_snippet: `Local Heat–Aridity coupling r=${heatAridityComp.pearsonR.toFixed(2)} (r*=${heatAridityComp.detrendedR.toFixed(2)})`,
          rationale: `Co-located thermal vs humidity coupling at ${evSig.properties.name} (${heatAridityComp.mechanism}, Δt=${heatAridityComp.optimalLagSteps} ${heatAridityComp.lagUnit}).`,
          silent: true,
        });
      }
    }

    if (thermalNodeUuid && hydroNodeUuid && precipSeries.length >= 5) {
      const heatPrecipComp = compareRegionalSeries(thermalSeries, precipSeries, {
        latA: lat,
        lngA: lng,
        datasetA: thermalDatasetUsed,
        latB: lat,
        lngB: lng,
        datasetB: "hydrology",
      });
      if (Math.abs(heatPrecipComp.pearsonR) >= 0.35 && heatPrecipComp.pValue < 0.05) {
        store.createEdge({
          uuid: `edge-local-pr-${crypto.createHash("sha1").update(`${thermalNodeUuid}:${hydroNodeUuid}`).digest("hex").slice(0, 8)}`,
          source_uuid: thermalNodeUuid,
          target_uuid: hydroNodeUuid,
          type: heatPrecipComp.pearsonR < 0 ? "drives_opposite" : "correlates_with",
          correlation_r: heatPrecipComp.pearsonR,
          detrended_r: heatPrecipComp.detrendedR,
          optimal_lag_steps: heatPrecipComp.optimalLagSteps,
          lag_unit: heatPrecipComp.lagUnit,
          mechanism: heatPrecipComp.mechanism,
          amplification_ratio: heatPrecipComp.slopeRatio,
          shared_shift_year: heatPrecipComp.sharedRegimeShiftYear ?? undefined,
          source_snippet: `Local Thermal–Precip feedback r=${heatPrecipComp.pearsonR.toFixed(2)}`,
          rationale: `Co-located land thermal vs precipitation shift at ${evSig.properties.name} (${heatPrecipComp.mechanism}, r*=${heatPrecipComp.detrendedR.toFixed(2)}).`,
          silent: true,
        });
      }
    }
  }

  // 5b. Register Challenge Space-Agency Producer Concepts & Ingest NOAA CDO, KNMI, CSA/Geo.ca, SWOT/RCM, and USGS/SeaWiFS
  store.createNode({
    uuid: "concept-noaa-cdo",
    label: "Concept",
    is_provisional: false,
    silent: true,
    properties: {
      name: "NOAA NCEI Climate Data Online (CDO)",
      concept_name: "NOAA CDO Station Archive",
      description:
        "NOAA NCEI Global Summary of the Year station observations across Alaska, California, Europe, and Australia.",
      status: "Active",
      importance: 8,
      lat: 35.6,
      lng: -82.55,
      region: "Asheville, NC · Global Surface Network",
      dataset: "nasa_power",
      producer_type: "research_station",
      source_system: "NOAA NCEI CDO",
      source_url: "https://www.ncei.noaa.gov/cdo-web/",
      observed_at: "2024-12-31T00:00:00.000Z",
      created_at: now,
    },
  });

  store.createNode({
    uuid: "concept-knmi-explorer",
    label: "Concept",
    is_provisional: false,
    silent: true,
    properties: {
      name: "KNMI Climate Explorer Teleconnection Indices",
      concept_name: "KNMI Climate Explorer",
      description:
        "Royal Netherlands Meteorological Institute planetary climate mode indices (ENSO Niño 3.4, AMO, PDO, NAO).",
      status: "Active",
      importance: 9,
      lat: 52.1,
      lng: 5.18,
      region: "De Bilt, Netherlands · Global Modes",
      dataset: "ocean_temp",
      producer_type: "research_station",
      source_system: "KNMI Climate Explorer",
      source_url: "https://climexp.knmi.nl/",
      observed_at: "2024-12-31T00:00:00.000Z",
      created_at: now,
    },
  });

  store.createNode({
    uuid: "concept-csa-geoca-rcm",
    label: "Concept",
    is_provisional: false,
    silent: true,
    properties: {
      name: "CSA RADARSAT Constellation (RCM) & GEO.ca",
      concept_name: "CSA RCM & GEO.ca",
      description:
        `Canadian Space Agency C-band SAR trio (${orbitalMeta.rcmCollectionCount || 3} CMR SAR collections) paired with GEO.ca Arctic climate and hydrometric river gauges.`,
      status: "Active",
      importance: 9,
      lat: 45.52,
      lng: -73.39,
      region: "Saint-Hubert, QC · Canadian Arctic & Basins",
      dataset: "hydrology",
      producer_type: "nasa_satellite",
      source_system: "CSA RCM & GEO.ca",
      source_url: "https://donnees-data.asc-csa.gc.ca/en/dataset/rcm",
      observed_at: now,
      created_at: now,
    },
  });

  store.createNode({
    uuid: "concept-nasa-swot",
    label: "Concept",
    is_provisional: false,
    silent: true,
    properties: {
      name: "NASA / CNES / CSA SWOT Surface Water Mission",
      concept_name: "SWOT Hydrology Mission",
      description:
        "Wide-swath Ka-band radar interferometer measuring river width, water surface elevation, and discharge across 90% of Earth's surface water.",
      status: "Active",
      importance: 9,
      lat: 34.2,
      lng: -118.17,
      region: "Global Surface Water Swath",
      dataset: "hydrology",
      producer_type: "nasa_satellite",
      source_system: "NASA/CNES/CSA SWOT",
      source_url: "https://www.asc-csa.gc.ca/eng/satellites/swot/",
      observed_at: orbitalMeta.passes[0]?.observedAt || now,
      created_at: now,
    },
  });

  store.createNode({
    uuid: "concept-nasa-giovanni-appeears",
    label: "Concept",
    is_provisional: false,
    silent: true,
    properties: {
      name: "NASA Giovanni, AppEEARS & SeaWiFS Ocean Color",
      concept_name: "Giovanni · AppEEARS · SeaWiFS",
      description:
        `NASA GES DISC Giovanni, ${orbitalMeta.appeearsProductCount || 8}+ LP DAAC AppEEARS geospatial products, and ${orbitalMeta.seawifsCollectionTitle || "SeaWiFS Chlorophyll"} river-plume methodology.`,
      status: "Active",
      importance: 8,
      lat: 38.99,
      lng: -76.85,
      region: "GSFC / LP DAAC Earthdata",
      dataset: "air_quality",
      producer_type: "nasa_satellite",
      source_system: "NASA Giovanni & AppEEARS",
      source_url: "https://giovanni.gsfc.nasa.gov/",
      observed_at: now,
      created_at: now,
    },
  });

  const agencyRecordsToIngest = [
    ...noaaCdoRecords.map((r) => ({ rec: r, conceptId: "concept-noaa-cdo", kind: "cdo" as const })),
    ...knmiRecords.map((r) => ({ rec: r, conceptId: "concept-knmi-explorer", kind: "knmi" as const })),
    ...geocaRecords.map((r) => ({ rec: r, conceptId: "concept-csa-geoca-rcm", kind: "geoca" as const })),
    ...(usgsPlumeRecord
      ? [{ rec: usgsPlumeRecord, conceptId: "concept-nasa-giovanni-appeears", kind: "usgs" as const }]
      : []),
  ];

  const ingestedAgencySummaries: Array<{
    uuid: string;
    rec: (typeof agencyRecordsToIngest)[number]["rec"];
    summary: TrendAnalysisSummary;
    kind: (typeof agencyRecordsToIngest)[number]["kind"];
  }> = [];

  for (const { rec, conceptId, kind } of agencyRecordsToIngest) {
    const aSummary = analyzeTimeSeries(rec.points, {
      lat: rec.lat,
      lng: rec.lng,
      dataset: rec.dataset,
      parameter: rec.parameter,
      unit: rec.unit,
      slopeUnit: rec.slopeUnit,
      provenance: rec.provenance,
    });
    const sigUuid = `signal-${rec.id}`;
    const lastYr = rec.points[rec.points.length - 1]?.date || "2024";
    const mk = aSummary.mannKendall;

    store.createNode({
      uuid: sigUuid,
      label: "Signal",
      is_provisional: false,
      silent: true,
      properties: {
        name: rec.name,
        concept_name: rec.parameter,
        description: `${rec.sourceSystem} (${rec.points[0]?.date}–${lastYr}): latest ${aSummary.latestValue.toFixed(2)} ${rec.unit}. MK p=${mk.pValue.toFixed(4)} (Hamed-Rao p*=${mk.pValueAdjusted.toFixed(4)}), OLS R²=${aSummary.ols.rSquared.toFixed(2)}, Theil-Sen ${formatSlope(aSummary.theilSen.slope, rec.slopeUnit)}.`,
        status: "Active",
        importance: mk.significant ? 9 : 7,
        lat: rec.lat,
        lng: rec.lng,
        region: rec.region,
        dataset: rec.dataset,
        producer_type: rec.producerType,
        source_system: rec.sourceSystem,
        source_url: rec.sourceUrl,
        parameter: rec.parameter,
        provenance_source: rec.provenance,
        confidence: mk.significant ? 0.96 : 0.88,
        value: Number(aSummary.latestValue.toFixed(2)),
        unit: rec.unit,
        p_value: mk.pValue,
        p_value_adjusted: mk.pValueAdjusted,
        ols_r2: aSummary.ols.rSquared,
        regime_shift_year: aSummary.changePoint?.significant ? aSummary.changePoint.date : undefined,
        theil_sen_slope: Number(aSummary.theilSen.slope.toFixed(4)),
        slope_unit: rec.slopeUnit,
        temporal_scale: "year",
        series: rec.points,
        observed_at: `${lastYr}-07-01T00:00:00.000Z`,
        created_at: now,
      },
    });

    const monthlyKnmi = kind === "knmi" ? knmiMonthlyById.get(rec.id) : undefined;
    if (monthlyKnmi && monthlyKnmi.points.length >= 12) {
      store.setNodeMultiScaleSeries(sigUuid, "month", monthlyKnmi.points, true);
      store.setNodeMultiScaleSeries(sigUuid, "year", rec.points, true);
    }

    store.createEdge({
      uuid: `edge-mon-${rec.id}`,
      source_uuid: conceptId,
      target_uuid: sigUuid,
      type: "monitors",
      source_snippet: `${rec.sourceSystem} (${rec.parameter})`,
      silent: true,
    });

    ingestedAgencySummaries.push({ uuid: sigUuid, rec, summary: aSummary, kind });

    // Cross-corroborate Arctic stations directly into the Arctic Polar Amplification Insight when Arctic band revision exists
    if (
      arcticRevisedUuid &&
      (rec.id === "noaa-cdo-usw00027502" || rec.id === "geoca-ahccd-2400573")
    ) {
      store.createEdge({
        uuid: `edge-corr-arctic-${rec.id}`,
        source_uuid: sigUuid,
        target_uuid: arcticRevisedUuid,
        type: "corroborates",
        source_snippet: `${rec.sourceSystem} Arctic ground station confirmation`,
        rationale: `${rec.name} station observations corroborate high-latitude warming (slope ${formatSlope(aSummary.theilSen.slope, rec.slopeUnit)}).`,
        silent: true,
      });
      store.evaluateCorroboration(arcticRevisedUuid, false);
    }

    seriesCandidates.push({
      nodeUuid: sigUuid,
      name: rec.name,
      region: rec.region,
      lat: rec.lat,
      lng: rec.lng,
      dataset: rec.dataset,
      summary: aSummary,
      series: rec.points,
    });
  }

  // Record live NASA/CNES/CSA SWOT orbital river passes and link to river basin hydrology signals
  let swotGranulesLinked = 0;
  for (const pass of orbitalMeta.passes) {
    const passUuid = `signal-${pass.id}`;
    store.createNode({
      uuid: passUuid,
      label: "Signal",
      is_provisional: false,
      silent: true,
      properties: {
        name: pass.title,
        concept_name: "SWOT RiverSP Orbital Pass",
        description: pass.summary,
        status: "Active",
        importance: 7,
        lat: pass.lat,
        lng: pass.lng,
        region: classifyEarthRegionByCoord(pass.lat, pass.lng).label,
        dataset: "hydrology",
        producer_type: "nasa_satellite",
        source_system: "NASA/CNES/CSA SWOT",
        source_url: pass.sourceUrl,
        parameter: "SWOT_L2_HR_RiverSP_2.0",
        confidence: 0.94,
        observed_at: pass.observedAt,
        created_at: now,
      },
    });
    store.createEdge({
      uuid: `edge-mon-${pass.id}`,
      source_uuid: "concept-nasa-swot",
      target_uuid: passUuid,
      type: "monitors",
      source_snippet: "Live CMR SWOT_L2_HR_RiverSP_2.0 granule",
      silent: true,
    });
    swotGranulesLinked++;
  }

  // Promote Geo.ca Mackenzie River Arctic Delta hydrology into a multi-agency Insight corroborated by SWOT + CSA RCM
  const mackenzie = ingestedAgencySummaries.find((x) => x.rec.id === "geoca-mackenzie-10lc014");
  if (mackenzie) {
    const mackInsightUuid = "insight-mackenzie-arctic-hydrology";
    store.createNode({
      uuid: mackInsightUuid,
      label: "Insight",
      is_provisional: true,
      silent: true,
      properties: {
        name: "Mackenzie Arctic Delta River Regime (CSA GEO.ca + SWOT)",
        concept_name: "Arctic Basin Hydrology Synthesis",
        description: `Geo.ca hydrometric discharge at Arctic Red River (${mackenzie.rec.points[0]?.date}–${mackenzie.rec.points[mackenzie.rec.points.length - 1]?.date}) fused with CSA RCM permafrost/ice C-band SAR and SWOT surface water interferometry.`,
        status: "Provisional",
        importance: 8,
        lat: mackenzie.rec.lat,
        lng: mackenzie.rec.lng,
        region: mackenzie.rec.region,
        dataset: "hydrology",
        producer_type: "nasa_satellite",
        source_system: "CSA GEO.ca + SWOT + RCM",
        source_url: mackenzie.rec.sourceUrl,
        parameter: mackenzie.rec.parameter,
        provenance_source: mackenzie.rec.provenance,
        confidence: 0.92,
        value: Number(mackenzie.summary.latestValue.toFixed(1)),
        unit: mackenzie.rec.unit,
        p_value: mackenzie.summary.mannKendall.pValue,
        p_value_adjusted: mackenzie.summary.mannKendall.pValueAdjusted,
        ols_r2: mackenzie.summary.ols.rSquared,
        theil_sen_slope: Number(mackenzie.summary.theilSen.slope.toFixed(4)),
        slope_unit: mackenzie.rec.slopeUnit,
        series: mackenzie.rec.points,
        observed_at: `${mackenzie.rec.points[mackenzie.rec.points.length - 1]?.date}-06-01T00:00:00.000Z`,
        created_at: now,
      },
    });
    insightsCreated++;
    store.createEdge({
      uuid: "edge-supp-mack-gauge",
      source_uuid: mackenzie.uuid,
      target_uuid: mackInsightUuid,
      type: "supports",
      source_snippet: "Geo.ca 10LC014 hydrometric discharge gauge",
      silent: true,
    });
    store.createEdge({
      uuid: "edge-corr-mack-swot",
      source_uuid: "concept-nasa-swot",
      target_uuid: mackInsightUuid,
      type: "corroborates",
      source_snippet: "SWOT KaRIn wide-swath surface elevation monitoring",
      silent: true,
    });
    store.evaluateCorroboration(mackInsightUuid, false);

    // Wire Arctic Cryosphere / Atmosphere cascade into Mackenzie Arctic Basin discharge
    const arcticCandidate = arcticRevisedUuid
      ? seriesCandidates.find((c) => c.nodeUuid === arcticRevisedUuid)
      : undefined;
    if (arcticCandidate) {
      const arctMackComp = compareRegionalSeries(arcticCandidate.series, mackenzie.rec.points, {
        latA: arcticCandidate.lat,
        lngA: arcticCandidate.lng,
        datasetA: arcticCandidate.dataset,
        latB: mackenzie.rec.lat,
        lngB: mackenzie.rec.lng,
        datasetB: "hydrology",
      });
      store.createEdge({
        uuid: "edge-cascade-arctic-mackenzie",
        source_uuid: arcticCandidate.nodeUuid,
        target_uuid: mackInsightUuid,
        type: "teleconnects",
        correlation_r: arctMackComp.pearsonR,
        detrended_r: arctMackComp.detrendedR,
        optimal_lag_steps: arctMackComp.optimalLagSteps,
        lag_unit: arctMackComp.lagUnit,
        mechanism: "Polar Amplification Cascade",
        amplification_ratio: arctMackComp.slopeRatio,
        shared_shift_year: arctMackComp.sharedRegimeShiftYear ?? undefined,
        source_snippet: `Arctic 64N–90N warming -> Mackenzie runoff (r=${arctMackComp.pearsonR.toFixed(2)})`,
        rationale: `Polar amplification accelerates permafrost thaw and nival discharge across the Mackenzie Delta (${arctMackComp.mechanism}, r=${arctMackComp.pearsonR.toFixed(2)}, Δt=${arctMackComp.optimalLagSteps} ${arctMackComp.lagUnit}).`,
        silent: true,
      });
    }

    const iceMackComp = compareRegionalSeries(nsidcRes.points, mackenzie.rec.points, {
      latA: 82.5,
      lngA: -135.0,
      datasetA: "ocean_temp",
      latB: mackenzie.rec.lat,
      lngB: mackenzie.rec.lng,
      datasetB: "hydrology",
    });
    if (Math.abs(iceMackComp.pearsonR) >= 0.35) {
      store.createEdge({
        uuid: "edge-cascade-ice-mackenzie",
        source_uuid: nsidcSignalUuid,
        target_uuid: mackInsightUuid,
        type: iceMackComp.pearsonR < 0 ? "drives_opposite" : "teleconnects",
        correlation_r: iceMackComp.pearsonR,
        detrended_r: iceMackComp.detrendedR,
        optimal_lag_steps: iceMackComp.optimalLagSteps,
        lag_unit: iceMackComp.lagUnit,
        mechanism: "Polar Amplification Cascade",
        amplification_ratio: iceMackComp.slopeRatio,
        shared_shift_year: iceMackComp.sharedRegimeShiftYear ?? undefined,
        source_snippet: `Beaufort Sea Ice retreat vs Mackenzie Delta discharge (r=${iceMackComp.pearsonR.toFixed(2)})`,
        rationale: `Declining Beaufort/Arctic sea ice cover links to intensified Mackenzie watershed river discharge (r=${iceMackComp.pearsonR.toFixed(2)}, r*=${iceMackComp.detrendedR.toFixed(2)}).`,
        silent: true,
      });
    }
  }

  // Promote significant NOAA CDO / KNMI / USGS coastal stations into Insights where MK p < 0.05
  for (const item of ingestedAgencySummaries) {
    if (item.rec.id === "geoca-mackenzie-10lc014") continue;
    if (!item.summary.mannKendall.significant) continue;

    const dir = item.summary.theilSen.slope >= 0 ? "Increasing" : "Decreasing";
    const insightUuid = `insight-${item.rec.id}`;
    store.createNode({
      uuid: insightUuid,
      label: "Insight",
      is_provisional: item.kind !== "knmi",
      silent: true,
      properties: {
        name: `${item.rec.parameter} · ${dir} Trend (${item.rec.sourceSystem})`,
        concept_name: `${item.rec.parameter} ${dir}`,
        description: `${item.rec.name} shows statistically significant ${dir.toLowerCase()} trend (MK p=${item.summary.mannKendall.pValue.toFixed(4)}, Hamed-Rao p*=${item.summary.mannKendall.pValueAdjusted.toFixed(4)}, OLS R²=${item.summary.ols.rSquared.toFixed(2)}, slope ${formatSlope(item.summary.theilSen.slope, item.rec.slopeUnit)}).`,
        status: item.kind === "knmi" ? "Active" : "Provisional",
        importance: 9,
        lat: item.rec.lat,
        lng: item.rec.lng,
        region: item.rec.region,
        dataset: item.rec.dataset,
        producer_type: item.rec.producerType,
        source_system: item.rec.sourceSystem,
        source_url: item.rec.sourceUrl,
        parameter: item.rec.parameter,
        provenance_source: item.rec.provenance,
        confidence: 0.94,
        value: Number(item.summary.latestValue.toFixed(2)),
        unit: item.rec.unit,
        p_value: item.summary.mannKendall.pValue,
        p_value_adjusted: item.summary.mannKendall.pValueAdjusted,
        ols_r2: item.summary.ols.rSquared,
        regime_shift_year: item.summary.changePoint?.significant ? item.summary.changePoint.date : undefined,
        theil_sen_slope: Number(item.summary.theilSen.slope.toFixed(4)),
        slope_unit: item.rec.slopeUnit,
        series: item.rec.points,
        observed_at: `${item.rec.points[item.rec.points.length - 1]?.date}-07-01T00:00:00.000Z`,
        created_at: now,
      },
    });
    insightsCreated++;

    store.createEdge({
      uuid: `edge-supp-${item.rec.id}`,
      source_uuid: item.uuid,
      target_uuid: insightUuid,
      type: "supports",
      source_snippet: `${item.rec.sourceSystem} slope ${formatSlope(item.summary.theilSen.slope, item.rec.slopeUnit)}`,
      silent: true,
    });

    if (item.rec.dataset === "nasa_power" || item.rec.dataset === "ocean_temp") {
      const bandId = findMatchingGistempBandId(item.rec.lat);
      const bandNode = gistempSignalByBand.get(bandId);
      if (bandNode) {
        const comp = compareRegionalSeries(bandNode.points, item.rec.points);
        if (comp.pearsonR >= 0.35) {
          store.createEdge({
            uuid: `edge-corr-gistemp-${item.rec.id}`,
            source_uuid: bandNode.node.uuid,
            target_uuid: insightUuid,
            type: "corroborates",
            correlation_r: comp.pearsonR,
            source_snippet: `NASA GISTEMP ${bandId.toUpperCase()} satellite cross-check (r=${comp.pearsonR.toFixed(2)})`,
            silent: true,
          });
        }
      }
    }

    store.evaluateCorroboration(insightUuid, false);
    store.createEdge({
      uuid: `edge-mk-${insightUuid}`,
      source_uuid: "rule-mann-kendall",
      target_uuid: insightUuid,
      type: "verified_by",
      source_snippet: `MK p=${item.summary.mannKendall.pValue.toFixed(4)}`,
      silent: true,
    });
  }

  // Wire KNMI climate indices (Niño 3.4 / AMO / PDO / NAO) to global/coastal regional signals via `teleconnects`
  for (const knmiItem of ingestedAgencySummaries.filter((x) => x.kind === "knmi")) {
    let wiredTele = 0;
    for (const target of seriesCandidates) {
      if (wiredTele >= 2) break;
      if (target.nodeUuid === knmiItem.uuid || target.nodeUuid.startsWith("signal-knmi-")) continue;
      if (haversineKm(knmiItem.rec.lat, knmiItem.rec.lng, target.lat, target.lng) < 2000) continue;
      const cmp = compareRegionalSeries(knmiItem.rec.points, target.series, {
        latA: knmiItem.rec.lat,
        lngA: knmiItem.rec.lng,
        datasetA: knmiItem.rec.dataset,
        latB: target.lat,
        lngB: target.lng,
        datasetB: target.dataset,
      });
      const bestR = Math.abs(cmp.optimalLagR) > Math.abs(cmp.pearsonR) ? cmp.optimalLagR : cmp.pearsonR;
      const bestP = Math.abs(cmp.optimalLagR) > Math.abs(cmp.pearsonR) ? cmp.optimalLagPValue : cmp.pValue;
      if (Math.abs(bestR) >= 0.42 && bestP < 0.05) {
        const isNeg = cmp.pearsonR < 0;
        const flipForLag = cmp.optimalLagSteps < 0;
        const sourceUuid = flipForLag ? target.nodeUuid : knmiItem.uuid;
        const targetUuid = flipForLag ? knmiItem.uuid : target.nodeUuid;
        const directedLag = Math.abs(cmp.optimalLagSteps);
        const ampRatio = flipForLag
          ? Math.abs(cmp.slopeRatio) > 1e-9
            ? 1 / cmp.slopeRatio
            : 0
          : cmp.slopeRatio;
        store.createEdge({
          uuid: `edge-knmi-${crypto.createHash("sha1").update(`${knmiItem.uuid}:${target.nodeUuid}`).digest("hex").slice(0, 9)}`,
          source_uuid: sourceUuid,
          target_uuid: targetUuid,
          type: isNeg && knmiItem.summary.theilSen.slope * target.summary.theilSen.slope < 0 ? "drives_opposite" : "teleconnects",
          correlation_r: cmp.pearsonR,
          detrended_r: cmp.detrendedR,
          optimal_lag_steps: directedLag,
          lag_unit: cmp.lagUnit,
          mechanism: cmp.mechanism,
          amplification_ratio: ampRatio,
          shared_shift_year: cmp.sharedRegimeShiftYear ?? undefined,
          cross_scale: true,
          source_snippet: `${knmiItem.rec.parameter} teleconnection r=${cmp.pearsonR.toFixed(2)} (r*=${cmp.detrendedR.toFixed(2)})`,
          rationale: `KNMI ${knmiItem.rec.parameter} exhibits a remote coupling with ${target.name} (${cmp.mechanism}: r=${cmp.pearsonR.toFixed(2)}, detrended r*=${cmp.detrendedR.toFixed(2)}, Δt=${directedLag} ${cmp.lagUnit}, p=${cmp.pValue.toFixed(4)}).`,
          silent: true,
        });
        wiredTele++;
      }
    }
  }

  // 6. Wire data-driven cross-region Knowledge Graph connections (drives_opposite & correlates_with)
  // Apply Benjamini-Hochberg FDR multiple-testing correction and prioritize interannual/lagged
  // physical variability over pure shared secular drift.
  const testedPairs: Array<{
    a: SeriesCandidate;
    b: SeriesCandidate;
    comp: CrossRegionComparison;
    couplingP: number;
    rawP: number;
  }> = [];

  for (let i = 0; i < seriesCandidates.length; i++) {
    for (let j = i + 1; j < seriesCandidates.length; j++) {
      const a = seriesCandidates[i];
      const b = seriesCandidates[j];
      if (a.nodeUuid === b.nodeUuid) continue;
      const distKm = haversineKm(a.lat, a.lng, b.lat, b.lng);
      if (distKm < 1800) continue;

      const comp = compareRegionalSeries(a.series, b.series, {
        latA: a.lat,
        lngA: a.lng,
        datasetA: a.dataset,
        latB: b.lat,
        lngB: b.lng,
        datasetB: b.dataset,
      });
      if (comp.alignedPoints.length < 3) continue;

      const rawP = Math.min(comp.pValue, comp.detrendedPValue, comp.optimalLagPValue);
      const couplingP = comp.isSecularDriftOnly
        ? Math.min(comp.detrendedPValue, comp.optimalLagPValue)
        : rawP;

      testedPairs.push({ a, b, comp, couplingP, rawP });
    }
  }

  const couplingQs = benjaminiHochbergAdjust(testedPairs.map((p) => p.couplingP));
  const rawQs = benjaminiHochbergAdjust(testedPairs.map((p) => p.rawP));

  const oppositeCandidates: Array<{
    a: SeriesCandidate;
    b: SeriesCandidate;
    comp: CrossRegionComparison;
    fdrQ: number;
    score: number;
  }> = [];

  const coTrendCandidates: Array<{
    a: SeriesCandidate;
    b: SeriesCandidate;
    comp: CrossRegionComparison;
    fdrQ: number;
    score: number;
  }> = [];

  testedPairs.forEach((pair, idx) => {
    const { a, b, comp } = pair;
    const fdrQ = couplingQs[idx] ?? 1;
    comp.fdrQValue = fdrQ;
    const slopeA = a.summary.theilSen.slope;
    const slopeB = b.summary.theilSen.slope;
    const atLeastOneSignificant =
      (a.summary.mannKendall.significant && a.summary.mannKendall.significantAdjusted) ||
      (b.summary.mannKendall.significant && b.summary.mannKendall.significantAdjusted);
    const physicalStrength = Math.max(Math.abs(comp.detrendedR), Math.abs(comp.optimalLagR));

    if (
      !comp.isSecularDriftOnly &&
      fdrQ < 0.05 &&
      slopeA * slopeB < 0 &&
      (comp.pearsonR <= -0.35 || comp.optimalLagR <= -0.45)
    ) {
      oppositeCandidates.push({
        a,
        b,
        comp,
        fdrQ,
        score:
          0.55 * physicalStrength +
          0.45 * Math.abs(comp.pearsonR) +
          (atLeastOneSignificant ? 0.2 : 0),
      });
    } else if (
      !comp.isSecularDriftOnly &&
      fdrQ < 0.05 &&
      slopeA * slopeB > 0 &&
      Math.max(comp.pearsonR, comp.optimalLagR) >= 0.72
    ) {
      coTrendCandidates.push({
        a,
        b,
        comp,
        fdrQ,
        score: 0.6 * physicalStrength + 0.4 * Math.abs(comp.pearsonR),
      });
    }
  });

  // Fallback only if zero non-secular pairs survive FDR across small batches
  if (oppositeCandidates.length === 0) {
    testedPairs.forEach((pair, idx) => {
      const rawQ = rawQs[idx] ?? 1;
      if (
        rawQ < 0.05 &&
        pair.a.summary.theilSen.slope * pair.b.summary.theilSen.slope < 0 &&
        pair.comp.pearsonR <= -0.45
      ) {
        pair.comp.fdrQValue = rawQ;
        oppositeCandidates.push({
          a: pair.a,
          b: pair.b,
          comp: pair.comp,
          fdrQ: rawQ,
          score: Math.abs(pair.comp.pearsonR) * 0.75,
        });
      }
    });
  }

  oppositeCandidates.sort((x, y) => y.score - x.score);
  coTrendCandidates.sort((x, y) => y.score - x.score);

  const oppDegree = new Map<string, number>();
  let oppositeDipolesWired = 0;
  for (const cand of oppositeCandidates) {
    if (oppositeDipolesWired >= 8) break;
    const degA = oppDegree.get(cand.a.nodeUuid) ?? 0;
    const degB = oppDegree.get(cand.b.nodeUuid) ?? 0;
    if (degA >= 3 || degB >= 3) continue;

    // Orient source from lead-lag driver when significant, otherwise stronger positive/magnitude slope
    const lagLedByB =
      cand.comp.optimalLagSteps < 0 && Math.abs(cand.comp.optimalLagR) >= 0.45;
    const lagLedByA =
      cand.comp.optimalLagSteps > 0 && Math.abs(cand.comp.optimalLagR) >= 0.45;
    const aLeads = lagLedByA
      ? true
      : lagLedByB
        ? false
        : cand.a.summary.theilSen.slope >= cand.b.summary.theilSen.slope;
    const [src, tgt] = aLeads ? [cand.a, cand.b] : [cand.b, cand.a];
    const directedLag = aLeads ? cand.comp.optimalLagSteps : -cand.comp.optimalLagSteps;
    const ampRatio = aLeads
      ? cand.comp.slopeRatio
      : Math.abs(cand.comp.slopeRatio) > 1e-9
        ? 1 / cand.comp.slopeRatio
        : 0;

    const edgeUuid = `edge-opp-${crypto.createHash("sha1").update(`${src.nodeUuid}:${tgt.nodeUuid}`).digest("hex").slice(0, 10)}`;
    store.createEdge({
      uuid: edgeUuid,
      source_uuid: src.nodeUuid,
      target_uuid: tgt.nodeUuid,
      type: "drives_opposite",
      correlation_r: cand.comp.pearsonR,
      detrended_r: cand.comp.detrendedR,
      optimal_lag_steps: directedLag,
      lag_unit: cand.comp.lagUnit,
      mechanism: cand.comp.mechanism,
      amplification_ratio: ampRatio,
      shared_shift_year: cand.comp.sharedRegimeShiftYear ?? undefined,
      source_snippet: `Empirical r=${cand.comp.pearsonR.toFixed(2)} · r*=${cand.comp.detrendedR.toFixed(2)} (FDR q=${cand.fdrQ.toExponential(1)})`,
      rationale: `${src.name} (${formatSlope(src.summary.theilSen.slope, src.summary.slopeUnit)}) diverges from ${tgt.name} (${formatSlope(tgt.summary.theilSen.slope, tgt.summary.slopeUnit)}) via ${cand.comp.mechanism} (r=${cand.comp.pearsonR.toFixed(2)}, detrended r*=${cand.comp.detrendedR.toFixed(2)}, FDR q=${cand.fdrQ.toExponential(1)}, Δt=${directedLag} ${cand.comp.lagUnit}).`,
      silent: true,
    });
    oppDegree.set(src.nodeUuid, (oppDegree.get(src.nodeUuid) ?? 0) + 1);
    oppDegree.set(tgt.nodeUuid, (oppDegree.get(tgt.nodeUuid) ?? 0) + 1);
    oppositeDipolesWired++;
  }

  const coDegree = new Map<string, number>();
  let coTrendingTeleconnectionsWired = 0;
  for (const cand of coTrendCandidates) {
    if (coTrendingTeleconnectionsWired >= 10) break;
    const degA = coDegree.get(cand.a.nodeUuid) ?? 0;
    const degB = coDegree.get(cand.b.nodeUuid) ?? 0;
    if (degA >= 2 || degB >= 2) continue;

    const bLeads =
      cand.comp.optimalLagSteps < 0 && Math.abs(cand.comp.optimalLagR) >= 0.45;
    const [src, tgt] = bLeads ? [cand.b, cand.a] : [cand.a, cand.b];
    const directedLag = bLeads ? -cand.comp.optimalLagSteps : cand.comp.optimalLagSteps;
    const ampRatio = bLeads
      ? Math.abs(cand.comp.slopeRatio) > 1e-9
        ? 1 / cand.comp.slopeRatio
        : 0
      : cand.comp.slopeRatio;

    const edgeUuid = `edge-corr-${crypto.createHash("sha1").update(`${src.nodeUuid}:${tgt.nodeUuid}`).digest("hex").slice(0, 10)}`;
    store.createEdge({
      uuid: edgeUuid,
      source_uuid: src.nodeUuid,
      target_uuid: tgt.nodeUuid,
      type: "correlates_with",
      correlation_r: cand.comp.pearsonR,
      detrended_r: cand.comp.detrendedR,
      optimal_lag_steps: directedLag,
      lag_unit: cand.comp.lagUnit,
      mechanism: cand.comp.mechanism,
      amplification_ratio: ampRatio,
      shared_shift_year: cand.comp.sharedRegimeShiftYear ?? undefined,
      source_snippet: `Co-trending r=${cand.comp.pearsonR.toFixed(2)} · r*=${cand.comp.detrendedR.toFixed(2)} (FDR q=${cand.fdrQ.toExponential(1)})`,
      rationale: `Synchronized shift between ${src.region} (${formatSlope(src.summary.theilSen.slope, src.summary.slopeUnit)}) and ${tgt.region} (${formatSlope(tgt.summary.theilSen.slope, tgt.summary.slopeUnit)}) — ${cand.comp.mechanism} (r=${cand.comp.pearsonR.toFixed(2)}, r*=${cand.comp.detrendedR.toFixed(2)}, FDR q=${cand.fdrQ.toExponential(1)}).`,
      silent: true,
    });
    coDegree.set(src.nodeUuid, degA + 1);
    coDegree.set(tgt.nodeUuid, degB + 1);
    coTrendingTeleconnectionsWired++;
  }

  const snapshotBeforeSummary = store.getSnapshot();
  const corroboratedInsights = snapshotBeforeSummary.stats.corroboratedTrends;

  const summary: GlobalDiscoverySummary = {
    sourcesQueried: [
      "NASA GISS GISTEMP v4 Zonal (1995–2025)",
      "NOAA GML Global Marine CO₂ (1995–2025)",
      "NOAA/NSIDC Sea Ice Index v4.0 (1995–2025)",
      "NOAA NCEI Climate Data Online CDO GSOY Stations",
      "KNMI Climate Explorer (ENSO Niño 3.4, AMO, PDO, NAO)",
      "CSA RADARSAT RCM, SWOT RiverSP & Geo.ca Hydrometric / AHCCD",
      "USGS / NASA NTRS SeaWiFS Coastal Plume & LP DAAC AppEEARS",
      "NASA EONET v3 Live Multi-Category Orbital Events",
      "NASA POWER MERRA-2 31-Year Coordinate Reanalysis (1995–2025)",
    ],
    gistempZonesIngested: gistempFull.zones.length,
    eonetEventsIngested: eonetSignals.length,
    nasaPowerSeriesAnalyzed,
    noaaCdoStationsIngested: noaaCdoRecords.length,
    knmiIndicesIngested: knmiRecords.length,
    csaGeocaSeriesIngested: geocaRecords.length + (usgsPlumeRecord ? 1 : 0),
    swotGranulesLinked,
    insightsCreated,
    corroboratedInsights,
    beliefRevisionsCreated,
    oppositeDipolesWired,
    coTrendingTeleconnectionsWired,
  };

  const finalSnapshot = store.recordActivity({
    kind: "discovery",
    summary: `Live multi-agency discovery wired ${snapshotBeforeSummary.stats.totalNodes} nodes & ${snapshotBeforeSummary.stats.totalEdges} edges (${noaaCdoRecords.length} NOAA CDO, ${knmiRecords.length} KNMI modes, ${geocaRecords.length} CSA/Geo.ca series, ${swotGranulesLinked} SWOT passes, NASA GISTEMP/EONET/POWER).`,
  });

  return {
    summary,
    snapshot: finalSnapshot,
  };
}
