import { describe, expect, it } from "vitest";
import {
  CURATED_EARTH_PLACES,
  parseCoordinateQuery,
  searchObservatoryTargets,
} from "@/lib/earth/placeSearch";
import type { ETGNode } from "@/types/etg";

describe("parseCoordinateQuery", () => {
  it("parses comma and space separated coordinates", () => {
    const c1 = parseCoordinateQuery("40.015, -105.2705");
    expect(c1).not.toBeNull();
    expect(c1?.kind).toBe("coordinate");
    expect(c1?.lat).toBeCloseTo(40.015, 3);
    expect(c1?.lng).toBeCloseTo(-105.2705, 3);

    const c2 = parseCoordinateQuery("18.29°S 147.70°E");
    expect(c2).not.toBeNull();
    expect(c2?.lat).toBeCloseTo(-18.29, 2);
    expect(c2?.lng).toBeCloseTo(147.7, 2);
  });

  it("rejects out-of-range coordinates or plain text queries", () => {
    expect(parseCoordinateQuery("120, -105")).toBeNull();
    expect(parseCoordinateQuery("40, -240")).toBeNull();
    expect(parseCoordinateQuery("Boulder, Colorado")).toBeNull();
  });
});

describe("searchObservatoryTargets", () => {
  const sampleNodes: ETGNode[] = [
    {
      uuid: "signal-boulder-pin",
      label: "Signal",
      is_provisional: false,
      properties: {
        name: "Boulder Foothills Alpine Snowpack",
        description: "High elevation snow water equivalent",
        region: "Boulder, CO",
        lat: 40.03,
        lng: -105.55,
        importance: 9,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    },
    {
      uuid: "concept-nongeo",
      label: "Concept",
      is_provisional: false,
      properties: {
        name: "ENSO Teleconnection Mode",
        description: "Non-geo concept",
        importance: 8,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    },
  ];

  it("returns curated places including Boulder, Colorado when searching Boulder", () => {
    const hits = searchObservatoryTargets("boulder", sampleNodes, 8);
    expect(hits.some((h) => h.label === "Boulder, Colorado" && h.kind === "place")).toBe(true);
    expect(hits.some((h) => h.nodeUuid === "signal-boulder-pin")).toBe(true);
    expect(hits.every((h) => h.nodeUuid !== "concept-nongeo")).toBe(true);
  });

  it("prioritizes explicit coordinates at index 0", () => {
    const hits = searchObservatoryTargets("-3.47, -62.22", sampleNodes, 8);
    expect(hits[0]?.kind).toBe("coordinate");
    expect(hits[0]?.lat).toBeCloseTo(-3.47, 2);
  });

  it("offers flagship places even on empty query focus", () => {
    const hits = searchObservatoryTargets("", sampleNodes, 6);
    expect(hits.length).toBe(6);
    expect(CURATED_EARTH_PLACES.length).toBeGreaterThanOrEqual(10);
  });
});
