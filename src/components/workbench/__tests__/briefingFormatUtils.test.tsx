import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  humanizeCitationSlug,
  renderFormattedBriefing,
} from "@/components/workbench/briefingFormatUtils";
import type { ETGNode } from "@/types/etg";

function makeNode(uuid: string, name: string, region?: string): ETGNode {
  return {
    uuid,
    label: "Signal",
    properties: {
      name,
      description: "Test Earth trend node",
      created_at: "2025-01-01T00:00:00Z",
      region,
    },
  };
}

describe("humanizeCitationSlug", () => {
  it("strips ETG prefixes and formats agency acronyms and coordinate parts", () => {
    expect(humanizeCitationSlug("signal-gistemp-zonal-64n-90n")).toBe(
      "GISTEMP Zonal 64°N 90°N"
    );
    expect(humanizeCitationSlug("insight-enso-modis-ndvi")).toBe("ENSO MODIS NDVI");
  });

  it("handles non-prefixed and empty-remainder strings safely", () => {
    expect(humanizeCitationSlug("modis_co2_trend")).toBe("MODIS CO2 Trend");
    expect(humanizeCitationSlug("concept-")).toBe("concept-");
  });
});

describe("renderFormattedBriefing", () => {
  it("formats bold markdown spans into <strong> elements", () => {
    const html = renderToStaticMarkup(
      <div>{renderFormattedBriefing("Strong **Arctic warming** detected.", new Map())}</div>
    );
    expect(html).toContain("<strong");
    expect(html).toContain("Arctic warming");
    expect(html).not.toContain("**");
  });

  it("renders resolved node references as interactive <button> pills when onSelectNode is provided", () => {
    const node = makeNode(
      "node-boulder-vpd",
      "boulder_wildfire_vpd_trend",
      "Colorado Front Range"
    );
    const nodeById = new Map<string, ETGNode>([[node.uuid, node]]);
    const onSelectNode = vi.fn();

    const html = renderToStaticMarkup(
      <div>
        {renderFormattedBriefing("Driven by [node-boulder-vpd].", nodeById, onSelectNode)}
      </div>
    );

    expect(html).toContain("<button");
    expect(html).toContain("Inspect cited node:");
    expect(html).toContain("Colorado Front Range");
    expect(html).not.toContain("[node-boulder-vpd]");
  });

  it("renders resolved node references as static <span> pills when onSelectNode is omitted", () => {
    const node = makeNode("node-pacific-sst", "Niño 3.4 SST Anomaly");
    const nodeById = new Map<string, ETGNode>([[node.uuid, node]]);

    const html = renderToStaticMarkup(
      <div>{renderFormattedBriefing("Linked to [node-pacific-sst].", nodeById)}</div>
    );

    expect(html).not.toContain("<button");
    expect(html).toContain("<span");
    expect(html).toContain("Niño 3.4 SST Anomaly");
    expect(html).not.toContain("[node-pacific-sst]");
  });

  it("humanizes unresolved ETG slug tokens into readable fallback spans and preserves ordinary brackets", () => {
    const html = renderToStaticMarkup(
      <div>
        {renderFormattedBriefing(
          "Telemetry [signal-noaa-sst-34s] confirms significance [p < 0.01].",
          new Map()
        )}
      </div>
    );

    expect(html).toContain("NOAA SST 34°S");
    expect(html).not.toContain("[signal-noaa-sst-34s]");
    expect(html).toContain("[p &lt; 0.01]");
  });
});
