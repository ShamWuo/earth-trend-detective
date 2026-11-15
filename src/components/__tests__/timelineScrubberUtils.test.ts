import { describe, expect, it } from "vitest";
import {
  TIMELINE_SLIDER_STEPS,
  cutoffMsToSliderStep,
  sliderStepToCutoffMs,
} from "@/components/TimelineScrubber";

describe("TimelineScrubber normalized step helpers", () => {
  it("preserves exact min/max bounds even when span is not divisible by 86,400,000 ms", () => {
    const safeMin = 1291161600000; // 2010-12-01T00:00:00.000Z
    const safeMax = 1794743482858; // 2026-11-15T11:51:22.858Z

    expect(cutoffMsToSliderStep(safeMin, safeMin, safeMax)).toBe(0);
    expect(cutoffMsToSliderStep(safeMax, safeMin, safeMax)).toBe(TIMELINE_SLIDER_STEPS);

    expect(sliderStepToCutoffMs(0, safeMin, safeMax)).toBe(safeMin);
    expect(sliderStepToCutoffMs(TIMELINE_SLIDER_STEPS, safeMin, safeMax)).toBe(safeMax);

    // Out-of-bounds steps clamp cleanly to exact safeMin / safeMax
    expect(sliderStepToCutoffMs(-10, safeMin, safeMax)).toBe(safeMin);
    expect(sliderStepToCutoffMs(TIMELINE_SLIDER_STEPS + 50, safeMin, safeMax)).toBe(safeMax);

    // Midpoint interpolates smoothly inside [safeMin, safeMax]
    const midMs = sliderStepToCutoffMs(TIMELINE_SLIDER_STEPS / 2, safeMin, safeMax);
    expect(midMs).toBeGreaterThan(safeMin);
    expect(midMs).toBeLessThan(safeMax);
  });
});
