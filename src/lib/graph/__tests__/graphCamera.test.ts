import { describe, expect, it } from "vitest";
import {
  computeCameraPanDelta,
  computeGlideEase,
  computeInitialContinuousLookAt,
  computeOrbitCameraPosition,
  computeOrbitSphericalCoordinates,
  computeSurfaceConnectionPoints,
  computeTargetOrbitDistance,
} from "@/lib/graph/graphCamera";

describe("graphCamera 3D navigation and surface edge helpers", () => {
  it("reconstructs exact Cartesian camera position from spherical orbit coordinates", () => {
    const target = { x: 18, y: -12, z: 24 };
    const camPos = { x: 96, y: 42, z: -85 };
    const spherical = computeOrbitSphericalCoordinates(camPos, target);
    const reconstructed = computeOrbitCameraPosition(
      target,
      spherical.dist,
      spherical.pitch,
      spherical.yaw
    );

    expect(reconstructed.x).toBeCloseTo(camPos.x, 4);
    expect(reconstructed.y).toBeCloseTo(camPos.y, 4);
    expect(reconstructed.z).toBeCloseTo(camPos.z, 4);
  });

  it("computes zero-snap continuous LookAt along current sightline", () => {
    const camPos = { x: 0, y: 0, z: 200 };
    const forward = { x: 0, y: 0, z: -1 };
    const target = { x: 30, y: 40, z: 0 };
    const expectedDist = Math.hypot(30, 40, -200);

    const lookAt = computeInitialContinuousLookAt(camPos, forward, target);
    expect(lookAt.x).toBeCloseTo(0, 6);
    expect(lookAt.y).toBeCloseTo(0, 6);
    expect(lookAt.z).toBeCloseTo(200 - expectedDist, 6);
  });

  it("applies symmetric smoothstep glide easing at boundaries and midpoint", () => {
    expect(computeGlideEase(-0.5)).toBe(0);
    expect(computeGlideEase(0)).toBe(0);
    expect(computeGlideEase(0.5)).toBeCloseTo(0.5, 6);
    expect(computeGlideEase(1)).toBe(1);
    expect(computeGlideEase(1.5)).toBe(1);
  });

  it("brings far cameras into comfortable orbit distance without overshooting close ones", () => {
    expect(computeTargetOrbitDistance(320, 85, 165)).toBe(165);
    expect(computeTargetOrbitDistance(120, 85, 165)).toBe(120);
    expect(computeTargetOrbitDistance(40, 85, 165)).toBe(68);
  });

  it("projects screen pan deltas into camera-perspective Right and Up vectors", () => {
    const delta = computeCameraPanDelta(10, 0, 0, 0, 225);
    expect(delta.x).toBeLessThan(0);
    expect(delta.y).toBe(0);
    expect(Math.abs(delta.z)).toBeLessThan(1e-9);
  });

  it("computes surface-to-surface edge endpoints outside node radii", () => {
    const src = { x: 0, y: 0, z: 0 };
    const tgt = { x: 100, y: 0, z: 0 };
    const { start, end } = computeSurfaceConnectionPoints(src, 12, tgt, 10, 0.36);

    expect(start[0]).toBeCloseTo(12 * 0.36, 4);
    expect(end[0]).toBeCloseTo(100 - 10 * 0.36, 4);
    expect(start[1]).toBe(0);
    expect(end[1]).toBe(0);
  });
});
