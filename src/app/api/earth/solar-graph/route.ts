import { NextResponse } from "next/server";
import {
  buildDenverSolarClimatologicalFallback,
  fetchDenverSolarClimateGraph,
} from "@/lib/solar/denverClimateGraph";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let startYear = 2019;
  let endYear = new Date().getUTCFullYear();
  try {
    const { searchParams } = new URL(request.url);
    const currentYear = new Date().getUTCFullYear();
    startYear = Math.max(2015, Math.min(2023, Number(searchParams.get("startYear")) || 2019));
    endYear = Math.max(startYear + 2, Math.min(currentYear, Number(searchParams.get("endYear")) || currentYear));
    const forceRefresh =
      searchParams.get("refresh") === "1" || searchParams.get("refresh") === "true";

    const result = await fetchDenverSolarClimateGraph(startYear, endYear, { forceRefresh });
    return NextResponse.json(result, { status: 200 });
  } catch {
    const fallback = buildDenverSolarClimatologicalFallback(startYear, endYear);
    return NextResponse.json(fallback, { status: 200 });
  }
}
