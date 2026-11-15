import { describe, expect, it } from "vitest";
import { computeSubsolarPoint } from "@/lib/earth/solarPosition";

describe("computeSubsolarPoint", () => {
  it("places the sun near +23.44 deg latitude on the June solstice", () => {
    const juneSolstice = new Date("2026-06-21T12:00:00Z");
    const pt = computeSubsolarPoint(juneSolstice);
    expect(pt.lat).toBeGreaterThan(23.3);
    expect(pt.lat).toBeLessThan(23.5);
    // At 12:00 UTC, subsolar longitude is near 0 deg (within ~0.5 deg for EoT)
    expect(Math.abs(pt.lng)).toBeLessThan(1.5);
  });

  it("places the sun near -23.44 deg latitude on the December solstice", () => {
    const decSolstice = new Date("2026-12-21T12:00:00Z");
    const pt = computeSubsolarPoint(decSolstice);
    expect(pt.lat).toBeLessThan(-23.3);
    expect(pt.lat).toBeGreaterThan(-23.5);
    expect(Math.abs(pt.lng)).toBeLessThan(1.5);
  });

  it("places the sun near the equator at the equinoxes", () => {
    const marchEquinox = new Date("2026-03-20T15:00:00Z");
    const ptMarch = computeSubsolarPoint(marchEquinox);
    expect(Math.abs(ptMarch.lat)).toBeLessThan(0.5);

    const septEquinox = new Date("2026-09-23T00:00:00Z");
    const ptSept = computeSubsolarPoint(septEquinox);
    expect(Math.abs(ptSept.lat)).toBeLessThan(0.5);
  });

  it("rotates subsolar longitude westward by ~15 deg per hour", () => {
    const t0 = new Date("2026-11-14T12:00:00Z");
    const t1 = new Date("2026-11-14T18:00:00Z");
    const p0 = computeSubsolarPoint(t0);
    const p1 = computeSubsolarPoint(t1);
    // 6 hours later, sun is ~90 deg further west (more negative)
    const deltaLng = p0.lng - p1.lng;
    expect(deltaLng).toBeCloseTo(90, 0);
  });

  it("accounts for the Equation of Time in early November (~+15 min)", () => {
    // Around Nov 14, apparent solar time is ~15.5 minutes ahead of mean solar time,
    // so at 12:00 UTC solar noon has already passed Greenwich ~15.5 min ago (~3.9 deg W).
    const nov14 = new Date("2026-11-14T12:00:00Z");
    const pt = computeSubsolarPoint(nov14);
    expect(pt.equationOfTimeMin).toBeGreaterThan(14);
    expect(pt.equationOfTimeMin).toBeLessThan(17);
    expect(pt.lng).toBeGreaterThan(-4.3);
    expect(pt.lng).toBeLessThan(-3.4);
  });
});
