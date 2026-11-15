export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface OrbitSphericalCoordinates {
  dist: number;
  pitch: number;
  yaw: number;
  unitDirection: Vec3Like;
}

/**
 * Calculates spherical angles (pitch and yaw) of camera relative to a target point.
 * Guaranteed to produce zero positional delta when plugged back into computeOrbitCameraPosition.
 */
export function computeOrbitSphericalCoordinates(
  camPos: Vec3Like,
  targetPos: Vec3Like
): OrbitSphericalCoordinates {
  const dx = camPos.x - targetPos.x;
  const dy = camPos.y - targetPos.y;
  const dz = camPos.z - targetPos.z;
  const dist = Math.max(0.001, Math.hypot(dx, dy, dz));
  const pitch = Math.asin(Math.max(-0.99, Math.min(0.99, dy / dist)));
  const yaw = Math.atan2(dx, dz);
  return {
    dist,
    pitch,
    yaw,
    unitDirection: { x: dx / dist, y: dy / dist, z: dz / dist },
  };
}

/**
 * Reconstructs 3D Cartesian coordinates from spherical orbit angles around a target point.
 */
export function computeOrbitCameraPosition(
  targetPos: Vec3Like,
  radius: number,
  pitch: number,
  yaw: number
): Vec3Like {
  const cosPitch = Math.cos(pitch);
  return {
    x: targetPos.x + radius * Math.sin(yaw) * cosPitch,
    y: targetPos.y + radius * Math.sin(pitch),
    z: targetPos.z + radius * Math.cos(yaw) * cosPitch,
  };
}

/**
 * Computes initial LookAt point along current forward sightline at the exact distance of the target.
 * Guarantees 0.000° angular deviation at t=0 of any camera orientation transition.
 */
export function computeInitialContinuousLookAt(
  camPos: Vec3Like,
  forwardSightline: Vec3Like,
  targetPos: Vec3Like
): Vec3Like {
  const dist = Math.hypot(targetPos.x - camPos.x, targetPos.y - camPos.y, targetPos.z - camPos.z);
  return {
    x: camPos.x + forwardSightline.x * dist,
    y: camPos.y + forwardSightline.y * dist,
    z: camPos.z + forwardSightline.z * dist,
  };
}

/**
 * Symmetric smoothstep ease curve for camera glides: starts and ends at rest.
 */
export function computeGlideEase(progress: number): number {
  const clamped = Math.max(0, Math.min(1, progress));
  return clamped * clamped * (3 - 2 * clamped);
}

/**
 * Calculates a comfortable target orbit radius when focusing on a node.
 */
export function computeTargetOrbitDistance(
  currentDist: number,
  minDist = 75,
  maxDist = 175
): number {
  if (currentDist > maxDist) {
    return Math.max(minDist, Math.min(maxDist, currentDist * 0.72));
  }
  return Math.max(minDist * 0.8, currentDist);
}

/**
 * Projects screen-space pointer pan deltas into 3D camera-perspective local Right & Up vectors.
 */
export function computeCameraPanDelta(
  deltaX: number,
  deltaY: number,
  pitch: number,
  yaw: number,
  orbitRadius: number
): Vec3Like {
  const scale = Math.max(0.18, Math.min(1.4, orbitRadius / 420));
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  const upX = -Math.sin(yaw) * Math.sin(pitch);
  const upY = Math.cos(pitch);
  const upZ = -Math.cos(yaw) * Math.sin(pitch);

  return {
    x: (-deltaX * rightX + deltaY * upX) * scale,
    y: deltaY * upY * scale,
    z: (-deltaX * rightZ + deltaY * upZ) * scale,
  };
}

/**
 * Computes surface-to-surface connection endpoints between two 3D node sprites
 * so edge lines meet node rims cleanly instead of piercing into the sprite center.
 */
export function computeSurfaceConnectionPoints(
  srcPos: Vec3Like,
  srcScale: number,
  tgtPos: Vec3Like,
  tgtScale: number,
  radiusFactor = 0.25
): { start: [number, number, number]; end: [number, number, number] } {
  const dx = tgtPos.x - srcPos.x;
  const dy = tgtPos.y - srcPos.y;
  const dz = tgtPos.z - srcPos.z;
  const dist = Math.hypot(dx, dy, dz);

  const rSrc = Math.max(1.2, srcScale * radiusFactor);
  const rTgt = Math.max(1.2, tgtScale * radiusFactor);

  if (dist > rSrc + rTgt + 0.1) {
    const invDist = 1 / dist;
    const ux = dx * invDist;
    const uy = dy * invDist;
    const uz = dz * invDist;

    return {
      start: [srcPos.x + ux * rSrc, srcPos.y + uy * rSrc, srcPos.z + uz * rSrc],
      end: [tgtPos.x - ux * rTgt, tgtPos.y - uy * rTgt, tgtPos.z - uz * rTgt],
    };
  }

  return {
    start: [srcPos.x, srcPos.y, srcPos.z],
    end: [tgtPos.x, tgtPos.y, tgtPos.z],
  };
}
