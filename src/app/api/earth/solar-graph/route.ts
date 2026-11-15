import { NextResponse } from "next/server";
import { classifyUpstreamFault, createTelemetryBudget } from "@/lib/earth/upstreamResilience";
import {
  buildDenverSolarClimatologicalFallback,
  fetchDenverSolarClimateGraph,
  fetchSolarClimateGraphForLocation,
} from "@/lib/solar/denverClimateGraph";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const budget = createTelemetryBudget(1550);
  let startYear = 2019;
  let endYear = new Date().getUTCFullYear();
  try {
    const { searchParams } = new URL(request.url);
    const currentYear = new Date().getUTCFullYear();
    startYear = Math.max(2015, Math.min(2023, Number(searchParams.get("startYear")) || 2019));
    endYear = Math.max(startYear + 2, Math.min(currentYear, Number(searchParams.get("endYear")) || currentYear));
    const forceRefresh =
      searchParams.get("refresh") === "1" || searchParams.get("refresh") === "true";

    const latRaw = searchParams.get("lat");
    const lngRaw = searchParams.get("lng");
    const nameRaw = searchParams.get("name")?.trim() || undefined;

    let customCoords: { lat: number; lng: number } | null = null;
    if (latRaw !== null || lngRaw !== null) {
      if (latRaw === null || lngRaw === null || latRaw.trim() === "" || lngRaw.trim() === "") {
        return NextResponse.json(
          { error: "Both 'lat' and 'lng' query parameters are required together." },
          { status: 400 }
        );
      }
      const parsedLat = Number(latRaw);
      const parsedLng = Number(lngRaw);
      if (
        !Number.isFinite(parsedLat) ||
        !Number.isFinite(parsedLng) ||
        parsedLat < -90 ||
        parsedLat > 90 ||
        parsedLng < -180 ||
        parsedLng > 180
      ) {
        return NextResponse.json(
          { error: "Invalid coordinates: 'lat' must be in [-90, 90] and 'lng' in [-180, 180]." },
          { status: 400 }
        );
      }
      customCoords = { lat: parsedLat, lng: parsedLng };
    }

    const pipeline = customCoords
      ? fetchSolarClimateGraphForLocation({
          lat: customCoords.lat,
          lng: customCoords.lng,
          name: nameRaw,
          startYear,
          endYear,
          forceRefresh,
        })
      : fetchDenverSolarClimateGraph(startYear, endYear, { forceRefresh });

    const result = await budget.raceWithFallback(pipeline, () => {
      const fb = buildDenverSolarClimatologicalFallback(startYear, endYear);
      return {
        ...fb,
        upstreamFault: {
          source: "Solar Microgrid Telemetry",
          kind: "timeout" as const,
          message: "Solar graph upstream deadline exceeded; using climatological fallback",
          retryable: false,
        },
        elapsedMs: budget.elapsedMs(),
      };
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const fault = classifyUpstreamFault(err, "Solar Microgrid Telemetry");
    const fallback = buildDenverSolarClimatologicalFallback(startYear, endYear);
    return NextResponse.json(
      { ...fallback, upstreamFault: fault, upstreamFaults: [fault], elapsedMs: budget.elapsedMs() },
      { status: 200 }
    );
  }
}
