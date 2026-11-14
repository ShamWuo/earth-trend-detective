import { NextRequest, NextResponse } from "next/server";
import { getEtgStore } from "@/lib/graph/etgStore";
import { fetchEarthTimeSeries } from "@/lib/nasa/nasaPowerClient";
import { analyzeTimeSeries } from "@/lib/stats/trendEngine";
import type { ETGDatasetId, TrendAnalysisSummary } from "@/types/etg";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      selectedNodeUuid?: string;
      lat?: number;
      lng?: number;
      dataset?: string;
      question?: string;
    };

    const store = getEtgStore();
    const snapshot = store.getSnapshot();
    const selectedNode = body.selectedNodeUuid
      ? store.getNode(body.selectedNodeUuid)
      : undefined;

    const fallbackGeoInsight = snapshot.nodes.find(
      (n) =>
        (n.label === "Insight" || n.label === "Signal") &&
        typeof n.properties.lat === "number" &&
        typeof n.properties.lng === "number"
    );

    const targetNode = selectedNode ?? fallbackGeoInsight;
    const targetLat = targetNode?.properties.lat ?? (typeof body.lat === "number" ? body.lat : undefined);
    const targetLng = targetNode?.properties.lng ?? (typeof body.lng === "number" ? body.lng : undefined);
    const dataset: ETGDatasetId =
      targetNode?.properties.dataset || (body.dataset as ETGDatasetId) || "nasa_power";

    const targetSeries = targetNode
      ? targetNode.properties.series ?? store.getNodeSeries(targetNode.uuid)
      : undefined;

    let telemetry: TrendAnalysisSummary | null = null;
    if (
      targetNode &&
      Array.isArray(targetSeries) &&
      targetSeries.length >= 5 &&
      targetLat !== undefined &&
      targetLng !== undefined
    ) {
      telemetry = analyzeTimeSeries(targetSeries, {
        lat: targetLat,
        lng: targetLng,
        dataset,
        parameter: targetNode.properties.parameter || targetNode.properties.name,
        unit: targetNode.properties.unit || "value",
        slopeUnit: targetNode.properties.slope_unit || "unit/yr",
        provenance: targetNode.properties.provenance_source || "Empirical Dataset (Imported)",
      });
    } else if (targetLat !== undefined && targetLng !== undefined) {
      try {
        telemetry = await fetchEarthTimeSeries(targetLat, targetLng, dataset);
      } catch {
        telemetry = null;
      }
    }

    const oppositePairs = snapshot.oppositeTrendPairs;

    // Optional Gemini synthesis if a valid API key is present
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && !apiKey.startsWith("your-") && snapshot.nodes.length > 0) {
      try {
        const promptText = [
          "You are Earth Trend Detective, a NASA Earth science analyst.",
          `Question: ${body.question || "Explain the active Earth trend, statistical significance, and cross-region teleconnections."}`,
          `Focused Node: ${selectedNode ? `${selectedNode.properties.name} [${selectedNode.uuid}] (${selectedNode.label})` : "Global Overview"}`,
          telemetry
            ? `Telemetry at (${telemetry.lat.toFixed(2)}, ${telemetry.lng.toFixed(2)}) [${telemetry.parameter}]: Mann-Kendall p=${telemetry.mannKendall.pValue.toFixed(4)}, Theil-Sen slope=${telemetry.theilSen.slope.toFixed(3)} ${telemetry.slopeUnit}, Verdict=${telemetry.verdict}.`
            : `Graph State: ${snapshot.stats.totalNodes} nodes, ${snapshot.stats.corroboratedTrends} corroborated trends.`,
          `Opposite Trend Pairs: ${oppositePairs
            .map(
              (p) =>
                `${p.source.properties.name} [${p.source.uuid}] -> ${p.target.properties.name} [${p.target.uuid}] (r=${p.correlationR ?? "N/A"}): ${p.rationale}`
            )
            .join(" | ")}`,
          "Keep your answer concise (3 short paragraphs), citing node UUIDs in brackets.",
        ].join("\n");

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(8000),
            body: JSON.stringify({
              contents: [{ parts: [{ text: promptText }] }],
            }),
          }
        );

        if (geminiRes.ok) {
          const data = (await geminiRes.json()) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
          };
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            return NextResponse.json({
              engine: "Gemini 2.5 Flash + ETG Telemetry",
              briefing: text,
              citedNodes: oppositePairs.slice(0, 3).flatMap((p) => [p.source.uuid, p.target.uuid]),
              telemetrySummary: telemetry
                ? {
                    verdict: telemetry.verdict,
                    pValue: telemetry.mannKendall.pValue,
                    slope: telemetry.theilSen.slope,
                    slopeUnit: telemetry.slopeUnit,
                  }
                : undefined,
            });
          }
        }
      } catch {
        // Fall back to deterministic scientific synthesis
      }
    }

    if (snapshot.nodes.length === 0 && !telemetry) {
      return NextResponse.json({
        engine: "Deterministic ETG Scientific Reasoner",
        briefing:
          "The Earth Trend Graph is currently empty (0 nodes, 0 hardcoded records). Run **Discover Live Global Trends** to ingest live NASA GISTEMP v4, NOAA GML CO₂, NASA EONET v3, and NASA POWER MERRA-2 datasets, or probe any coordinate on the 3D Earth.",
        citedNodes: [],
      });
    }

    const activeDipole =
      oppositePairs.find(
        (p) =>
          p.source.uuid === selectedNode?.uuid || p.target.uuid === selectedNode?.uuid
      ) || oppositePairs[0];

    const lines: string[] = [];
    if (selectedNode && telemetry) {
      lines.push(
        `**Signal Attribution (${selectedNode.label} · ${selectedNode.uuid}):** "${selectedNode.properties.name}" shows a **${telemetry.verdict}** at (${telemetry.lat.toFixed(2)}°, ${telemetry.lng.toFixed(2)}°) with Mann-Kendall \`p = ${telemetry.mannKendall.pValue.toFixed(4)}\` and Theil-Sen slope \`${telemetry.theilSen.slope >= 0 ? "+" : ""}${telemetry.theilSen.slope.toFixed(3)} ${telemetry.slopeUnit}\` (${telemetry.provenance}).`
      );
    } else if (telemetry) {
      lines.push(
        `**Global Earth Trend Summary:** Tracking **${snapshot.stats.corroboratedTrends} corroborated trends**, **${snapshot.stats.provisionalCount} provisional signal(s)**, and **${snapshot.stats.oppositeTrendPairsCount} active opposite-trend dipoles** across ${snapshot.stats.totalNodes} empirical nodes. Focus telemetry at (${telemetry.lat.toFixed(2)}°, ${telemetry.lng.toFixed(2)}°) yields Mann-Kendall \`p = ${telemetry.mannKendall.pValue.toFixed(4)}\` (${telemetry.verdict}).`
      );
    } else {
      lines.push(
        `**Global Earth Trend Summary:** Tracking **${snapshot.stats.corroboratedTrends} corroborated trends** across **${snapshot.stats.totalNodes} empirical nodes** and **${snapshot.stats.totalEdges} edges**.`
      );
    }

    if (activeDipole) {
      lines.push(
        `**Cross-Region Opposite Teleconnection:** \`${activeDipole.source.properties.name}\` [${activeDipole.source.uuid}] diverges against \`${activeDipole.target.properties.name}\` [${activeDipole.target.uuid}] (${activeDipole.correlationR !== undefined ? `r = ${activeDipole.correlationR.toFixed(2)}` : "inverse coupling"}): ${activeDipole.rationale}`
      );
    }

    lines.push(
      `**Epistemic Integrity:** Multi-source corroboration enforces ≥2 independent observational systems, while historical revisions remain auditable via \`supersedes\` lineage (${snapshot.stats.supersededCount} superseded assessment preserved).`
    );

    return NextResponse.json({
      engine: "Deterministic ETG Scientific Reasoner",
      briefing: lines.join("\n\n"),
      citedNodes: activeDipole
        ? [activeDipole.source.uuid, activeDipole.target.uuid]
        : selectedNode
          ? [selectedNode.uuid]
          : [],
      telemetrySummary: telemetry
        ? {
            verdict: telemetry.verdict,
            pValue: telemetry.mannKendall.pValue,
            slope: telemetry.theilSen.slope,
            slopeUnit: telemetry.slopeUnit,
          }
        : undefined,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Detective synthesis failed" },
      { status: 500 }
    );
  }
}
