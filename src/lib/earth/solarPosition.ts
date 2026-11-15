/**
 * Astronomical solar subpoint (subsolar latitude & longitude) calculator.
 *
 * Uses the USNO / Astronomical Almanac low-precision solar ephemeris
 * (accurate to ~0.01 deg for 1950-2050), accounting for Earth's axial tilt
 * (obliquity), orbital eccentricity, and the Equation of Time via GMST.
 */

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

function wrap360(deg: number): number {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

function wrap180(deg: number): number {
  const w = wrap360(deg);
  return w > 180 ? w - 360 : w;
}

export interface SubsolarPoint {
  /** Subsolar latitude in degrees [-23.44, +23.44] (solar declination). */
  lat: number;
  /** Subsolar longitude in degrees [-180, +180] (east positive). */
  lng: number;
  /** Solar declination in degrees. */
  declinationDeg: number;
  /** Equation of Time in minutes (apparent solar time minus mean solar time). */
  equationOfTimeMin: number;
}

/**
 * Computes the exact subsolar point on Earth for a given UTC Date.
 */
export function computeSubsolarPoint(date: Date = new Date()): SubsolarPoint {
  // Julian Date from Unix epoch (1970-01-01T00:00:00Z = JD 2440587.5)
  const jd = date.getTime() / 86_400_000 + 2440587.5;
  // Days since J2000.0 (2000-01-01T12:00:00Z = JD 2451545.0)
  const n = jd - 2451545.0;

  // Mean longitude of the Sun corrected for aberration (deg)
  const meanLongitudeDeg = wrap360(280.46 + 0.9856474 * n);
  // Mean anomaly of the Sun (deg)
  const meanAnomalyDeg = wrap360(357.528 + 0.9856003 * n);
  const gRad = meanAnomalyDeg * DEG_TO_RAD;

  // Ecliptic longitude of the Sun (deg)
  const eclipticLonDeg = wrap360(
    meanLongitudeDeg + 1.915 * Math.sin(gRad) + 0.02 * Math.sin(2 * gRad)
  );
  const lambdaRad = eclipticLonDeg * DEG_TO_RAD;

  // Obliquity of the ecliptic (deg)
  const obliquityDeg = 23.439 - 0.0000004 * n;
  const epsRad = obliquityDeg * DEG_TO_RAD;

  // Equatorial coordinates: Right Ascension & Declination
  const sinLambda = Math.sin(lambdaRad);
  const cosLambda = Math.cos(lambdaRad);
  const raRad = Math.atan2(Math.cos(epsRad) * sinLambda, cosLambda);
  const raDeg = wrap360(raRad * RAD_TO_DEG);

  const declRad = Math.asin(Math.sin(epsRad) * sinLambda);
  const declDeg = declRad * RAD_TO_DEG;

  // Greenwich Mean Sidereal Time (deg)
  const gmstDeg = wrap360(280.46061837 + 360.98564736629 * n);

  // Subsolar longitude = RA - GMST (wrapped to [-180, +180])
  const subsolarLng = wrap180(raDeg - gmstDeg);

  // Equation of Time: (Mean Longitude - Right Ascension) * 4 minutes/deg
  const equationOfTimeMin = wrap180(meanLongitudeDeg - raDeg) * 4;

  return {
    lat: declDeg,
    lng: subsolarLng,
    declinationDeg: declDeg,
    equationOfTimeMin,
  };
}
