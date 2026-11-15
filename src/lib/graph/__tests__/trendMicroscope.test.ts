import { describe, expect, it, vi } from "vitest";
import type { TrendMicroscopeStoreLike } from "@/lib/graph/trendMicroscope";
import { analyzeTimeSeries } from "@/lib/stats/trendEngine";
import type { ETGNode, TimeSeriesPoint } from "@/types/etg";

function makeMonthlySeries(slope: number, base: number, months = 24): TimeSeriesPoint[] {
  return Array.from({ length: months }, (_, i) => {
    const year = 2023 + Math.floor(i / 12);
    const monthNum = (i % 12) + 1;
    const date = `${year}-${String(monthNum).padStart(2, "0")}`;
    const t = year + (monthNum - 0.5) / 12;
    const seasonal = Math.sin((monthNum / 12) * Math.PI * 2) * 0.4;
    return {
      date,
      t,
      value: Number((base + slope * i + seasonal).toFixed(3)),
    };
  });
}

const mockMonthlySeries = makeMonthlySeries(0.18, 12.0, 24);
const mockFetchRegionalMultiScaleSeries = vi.hoisted(() => vi.fn());

vi.mock("@/lib/nasa/nasaPowerClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/nasa/nasaPowerClient")>();
  return {
    ...actual,
    fetchRegionalMultiScaleSeries: mockFetchRegionalMultiScaleSeries,
  };
});

import { scanTrendMicroscopeAsync } from "@/lib/graph/trendMicroscope";

describe("scanTrendMicroscopeAsync coordinate probing", () => {
  it("reads fetched.month from fetchRegionalMultiScaleSeries when probing remote coordinates", async () => {
    const summary = analyzeTimeSeries(mockMonthlySeries, {
      lat: 45.0,
      lng: -120.0,
      dataset: "nasa_power",
      parameter: "T2M",
      unit: "°C",
      slopeUnit: "°C/yr",
      provenance: "NASA POWER MERRA-2 (Live)",
    });

    mockFetchRegionalMultiScaleSeries.mockResolvedValueOnce({
      annual: [],
      month: mockMonthlySeries,
      day: [],
      summary,
      channelNames: ["T2M"],
    });

    const eqSeries = makeMonthlySeries(-0.14, 27.5, 24);
    const existingNode: ETGNode = {
      uuid: "eq-ref-1",
      label: "Signal",
      is_provisional: false,
      properties: {
        name: "Equatorial Reference SST",
        description: "Reference node >120 km from probed point",
        region: "Equatorial Central Pacific",
        lat: 0,
        lng: 0,
        dataset: "nasa_power",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    };

    const store: TrendMicroscopeStoreLike = {
      getSnapshot: () => ({ nodes: [existingNode], edges: [] }),
      getNode: (uuid) => (uuid === existingNode.uuid ? existingNode : undefined),
      getNodeSeries: (uuid) => (uuid === existingNode.uuid ? eqSeries : undefined),
      traverseSubgraph: () => ({ nodes: [existingNode], edges: [] }),
    };

    const result = await scanTrendMicroscopeAsync(store, {
      lat: 45.0,
      lng: -120.0,
      dataset: "nasa_power",
    });

    expect(mockFetchRegionalMultiScaleSeries).toHaveBeenCalledWith(45.0, -120.0, "nasa_power");
    expect(result.nodeCount).toBeGreaterThanOrEqual(2);
    expect(result.nodes.some((n) => n.uuid === "probe-45.00--120.00")).toBe(true);
  });
});
