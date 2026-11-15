import { NextResponse } from "next/server";
import { fetchDenverSolarClimateGraph } from "@/lib/solar/denverClimateGraph";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const currentYear = new Date().getUTCFullYear();
    const startYear = Math.max(2015, Math.min(2023, Number(searchParams.get("startYear")) || 2019));
    const endYear = Math.max(startYear + 2, Math.min(currentYear, Number(searchParams.get("endYear")) || currentYear));
    const forceRefresh =
      searchParams.get("refresh") === "1" || searchParams.get("refresh") === "true";

    const result = await fetchDenverSolarClimateGraph(startYear, endYear, { forceRefresh });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to compute Denver Solar Climate Graph";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
