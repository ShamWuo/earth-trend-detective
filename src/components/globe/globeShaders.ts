import * as THREE from "three";
import { EARTH_RADIUS } from "@/components/globe/globeGeometryAndArcs";

const GLSL_NOISE_HELPERS = `
  float hash31(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
  }

  float noise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(
        mix(hash31(i + vec3(0,0,0)), hash31(i + vec3(1,0,0)), f.x),
        mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x),
        f.y
      ),
      mix(
        mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
        mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x),
        f.y
      ),
      f.z
    );
  }
`;

/**
 * Builds the multi-spectral background starfield Points mesh and disposables.
 */
export function createStarfieldLayer(starTex: THREE.Texture): {
  stars: THREE.Points;
  starGeo: THREE.BufferGeometry;
  starMat: THREE.PointsMaterial;
} {
  const starCount = 1500;
  const starPositions = new Float32Array(starCount * 3);
  const starColors = new Float32Array(starCount * 3);
  const palette = [
    new THREE.Color(0xe2e8f0),
    new THREE.Color(0xbae6fd),
    new THREE.Color(0xfef3c7),
    new THREE.Color(0xcbd5e1),
  ];
  for (let i = 0; i < starCount; i++) {
    const r = 560 + Math.random() * 380;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    starPositions[i * 3 + 1] = r * Math.cos(phi);
    starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

    const c = palette[i % palette.length];
    const brightness = 0.42 + Math.random() * 0.58;
    starColors[i * 3] = c.r * brightness;
    starColors[i * 3 + 1] = c.g * brightness;
    starColors[i * 3 + 2] = c.b * brightness;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
  starGeo.setAttribute("color", new THREE.BufferAttribute(starColors, 3));
  const starMat = new THREE.PointsMaterial({
    size: 2.6,
    map: starTex,
    vertexColors: true,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(starGeo, starMat);
  return { stars, starGeo, starMat };
}

/**
 * 1. Cinema-Grade PBR-Inspired Orbital Earth Shader:
 * - 2K tangent-space mountain normals (land-masked, pole-faded) + subtle ocean micro-waves
 * - Real-time 3D cloud shadows projected onto oceans and continents along -sunDir
 * - Dual-lobe solar ocean glint occluded by clouds
 * - Sunlit Rayleigh aerial perspective + Mie sunset terminator + VIIRS city lights
 * - Full-sphere NASA GIBS / SVS scientific filters, 4-slice split & regional feather blending
 */
export function createEarthSurfaceMaterial(params: {
  blueMarbleTex: THREE.Texture;
  normalTex: THREE.Texture;
  waterTex: THREE.Texture;
  lightsTex: THREE.Texture;
  nightTex: THREE.Texture;
  cloudsTex: THREE.Texture;
  placeholderRegionalTex: THREE.Texture;
  sunDirection: THREE.Vector3;
  dayNightEnabled: boolean;
  cloudsEnabled: boolean;
  filterSmooth: boolean;
}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uDayMap: { value: params.blueMarbleTex },
      uNormalMap: { value: params.normalTex },
      uWaterMap: { value: params.waterTex },
      uLightsMap: { value: params.lightsTex },
      uNightMap: { value: params.nightTex },
      uCloudMap: { value: params.cloudsTex },
      uSunDir: { value: params.sunDirection.clone() },
      uDayNightEnabled: { value: params.dayNightEnabled ? 1.0 : 0.0 },
      uCloudDriftU: { value: 0.0 },
      uCloudsEnabled: { value: params.cloudsEnabled ? 1.0 : 0.0 },
      uRegionalMap: { value: params.placeholderRegionalTex },
      uRegionalBounds: { value: new THREE.Vector4(-113, 33, -97, 45) },
      uRegionalBlend: { value: 0.0 },
      uRegionalDataMode: { value: 0.0 },
      uRegionalMaxOpacity: { value: 1.0 },
      uSatCoarseMap: { value: params.placeholderRegionalTex },
      uSatCoarseMercBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
      uSatCoarseRelBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
      uSatCoarseBlend: { value: 0.0 },
      uSatMidMap: { value: params.placeholderRegionalTex },
      uSatMidMercBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
      uSatMidRelBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
      uSatMidBlend: { value: 0.0 },
      uSatPrevFineMap: { value: params.placeholderRegionalTex },
      uSatPrevFineMercBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
      uSatPrevFineRelBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
      uSatPrevFineBlend: { value: 0.0 },
      uSatFineMap: { value: params.placeholderRegionalTex },
      uSatFineMercBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
      uSatFineRelBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
      uSatFineBlend: { value: 0.0 },
      uGlobalLayerMap: { value: params.placeholderRegionalTex },
      uGlobalLayerBlend: { value: 0.0 },
      uGlobalDataMode: { value: 0.0 },
      uGlobalFilterMode: { value: 0.0 },
      uGlobalTexSize: { value: new THREE.Vector2(2048, 1024) },
      uFilterSmooth: { value: params.filterSmooth ? 1.0 : 0.0 },
      uBordersMap: { value: params.placeholderRegionalTex },
      uBordersLoaded: { value: 0.0 },
      uSliceWindsMap: { value: params.placeholderRegionalTex },
      uSlicePrecipMap: { value: params.placeholderRegionalTex },
      uSliceCloudsMap: { value: params.placeholderRegionalTex },
      uCameraRight: { value: new THREE.Vector3(1, 0, 0) },
    },
    vertexShader: `
      attribute vec4 aDetailMerc;
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      varying vec4 vDetailMerc;
      void main() {
        vUv = uv;
        vDetailMerc = aDetailMerc;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uDayMap;
      uniform sampler2D uNormalMap;
      uniform sampler2D uWaterMap;
      uniform sampler2D uLightsMap;
      uniform sampler2D uNightMap;
      uniform sampler2D uCloudMap;
      uniform vec3 uSunDir;
      uniform float uDayNightEnabled;
      uniform float uCloudDriftU;
      uniform float uCloudsEnabled;
      uniform sampler2D uRegionalMap;
      uniform vec4 uRegionalBounds;
      uniform float uRegionalBlend;
      uniform float uRegionalDataMode;
      uniform float uRegionalMaxOpacity;
      uniform sampler2D uSatCoarseMap;
      uniform vec4 uSatCoarseMercBounds;
      uniform vec4 uSatCoarseRelBounds;
      uniform float uSatCoarseBlend;
      uniform sampler2D uSatMidMap;
      uniform vec4 uSatMidMercBounds;
      uniform vec4 uSatMidRelBounds;
      uniform float uSatMidBlend;
      uniform sampler2D uSatPrevFineMap;
      uniform vec4 uSatPrevFineMercBounds;
      uniform vec4 uSatPrevFineRelBounds;
      uniform float uSatPrevFineBlend;
      uniform sampler2D uSatFineMap;
      uniform vec4 uSatFineMercBounds;
      uniform vec4 uSatFineRelBounds;
      uniform float uSatFineBlend;
      uniform sampler2D uGlobalLayerMap;
      uniform float uGlobalLayerBlend;
      uniform float uGlobalDataMode;
      uniform float uGlobalFilterMode;
      uniform vec2 uGlobalTexSize;
      uniform float uFilterSmooth;
      uniform sampler2D uBordersMap;
      uniform float uBordersLoaded;
      uniform sampler2D uSliceWindsMap;
      uniform sampler2D uSlicePrecipMap;
      uniform sampler2D uSliceCloudsMap;
      uniform vec3 uCameraRight;
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      varying vec4 vDetailMerc;

      ${GLSL_NOISE_HELPERS}

      float filterSmoothRadius(float mode) {
        if (mode < 1.5) return 1.15; // winds (2.5K MERRA-2 50km contour smoothing)
        if (mode < 2.5) return 0.90; // precip (5K IMERG 10km + vapor)
        if (mode < 3.5) return 0.70; // thermal (5K 1km MUR SST + MODIS LST)
        if (mode < 4.5) return 0.75; // sst_anomaly (5K 1km MUR SST — sharp eddies, smooth steps)
        if (mode < 5.5) return 1.15; // air_temp (2.5K MERRA-2 50km)
        if (mode < 6.5) return 1.15; // aerosols (2.5K MERRA-2 50km)
        if (mode < 7.5) return 0.35; // ndvi (5K 250m MODIS river basins)
        return 0.0;                  // true_color & night_viirs razor-sharp
      }

      vec4 sampleGlobalField(sampler2D tex, vec2 uv, vec2 texSize, float sinPhi, float radius) {
        if (radius <= 0.01) {
          return texture2D(tex, uv);
        }
        float lonScale = clamp(1.0 / max(0.26, sinPhi), 1.0, 3.0);
        vec2 px = vec2(radius * lonScale / max(512.0, texSize.x), radius / max(256.0, texSize.y));

        vec4 c0 = texture2D(tex, uv);
        vec4 i1 = texture2D(tex, vec2(fract(uv.x + 1.20 * px.x), clamp(uv.y + 0.40 * px.y, 0.0005, 0.9995)));
        vec4 i2 = texture2D(tex, vec2(fract(uv.x - 0.40 * px.x), clamp(uv.y + 1.20 * px.y, 0.0005, 0.9995)));
        vec4 i3 = texture2D(tex, vec2(fract(uv.x - 1.20 * px.x), clamp(uv.y - 0.40 * px.y, 0.0005, 0.9995)));
        vec4 i4 = texture2D(tex, vec2(fract(uv.x + 0.40 * px.x), clamp(uv.y - 1.20 * px.y, 0.0005, 0.9995)));
        vec4 o1 = texture2D(tex, vec2(fract(uv.x + 2.50 * px.x), clamp(uv.y - 0.80 * px.y, 0.0005, 0.9995)));
        vec4 o2 = texture2D(tex, vec2(fract(uv.x + 0.80 * px.x), clamp(uv.y + 2.50 * px.y, 0.0005, 0.9995)));
        vec4 o3 = texture2D(tex, vec2(fract(uv.x - 2.50 * px.x), clamp(uv.y + 0.80 * px.y, 0.0005, 0.9995)));
        vec4 o4 = texture2D(tex, vec2(fract(uv.x - 0.80 * px.x), clamp(uv.y - 2.50 * px.y, 0.0005, 0.9995)));

        float w0 = 0.22 * max(c0.a, 0.002);
        float wi1 = 0.12 * max(i1.a, 0.002);
        float wi2 = 0.12 * max(i2.a, 0.002);
        float wi3 = 0.12 * max(i3.a, 0.002);
        float wi4 = 0.12 * max(i4.a, 0.002);
        float wo1 = 0.075 * max(o1.a, 0.002);
        float wo2 = 0.075 * max(o2.a, 0.002);
        float wo3 = 0.075 * max(o3.a, 0.002);
        float wo4 = 0.075 * max(o4.a, 0.002);

        float wSum = w0 + wi1 + wi2 + wi3 + wi4 + wo1 + wo2 + wo3 + wo4;
        vec3 rgb = (
          c0.rgb * w0 +
          i1.rgb * wi1 + i2.rgb * wi2 + i3.rgb * wi3 + i4.rgb * wi4 +
          o1.rgb * wo1 + o2.rgb * wo2 + o3.rgb * wo3 + o4.rgb * wo4
        ) / max(0.0001, wSum);

        float alpha = 0.22 * c0.a +
          0.12 * (i1.a + i2.a + i3.a + i4.a) +
          0.075 * (o1.a + o2.a + o3.a + o4.a);

        return vec4(rgb, alpha);
      }

      vec4 sampleAerialMercatorPatch(
        sampler2D tex,
        vec4 mercBounds,
        vec4 relBounds,
        float fragLng,
        float fragLat,
        vec4 detailMerc
      ) {
        if (abs(fragLat) > 85.05) return vec4(0.0);
        float u;
        float v;
        if (detailMerc.z > 0.5) {
          u = (detailMerc.x - relBounds.x) * relBounds.z;
          v = 1.0 - (detailMerc.y - relBounds.y) * relBounds.w;
        } else {
          float latRad = radians(clamp(fragLat, -85.05, 85.05));
          float mercY = (1.0 - log(tan(0.7853981633974483 + 0.5 * latRad)) * 0.3183098861837907) * 0.5;
          float rawMercX = (fragLng + 180.0) / 360.0;
          float centerX = 0.5 * (mercBounds.x + mercBounds.z);
          float mercX = rawMercX + floor(centerX - rawMercX + 0.5);
          u = (mercX - mercBounds.x) / max(1e-7, mercBounds.z - mercBounds.x);
          v = 1.0 - (mercY - mercBounds.y) / max(1e-7, mercBounds.w - mercBounds.y);
        }
        if (u <= 0.001 || u >= 0.999 || v <= 0.001 || v >= 0.999) return vec4(0.0);
        float edgeDist = min(min(u, 1.0 - u), min(v, 1.0 - v));
        float feather = smoothstep(0.002, 0.042, edgeDist);
        vec4 texel = texture2D(tex, vec2(u, v));
        if (texel.a <= 0.02) return vec4(0.0);
        vec3 unpremultRgb = texel.rgb / max(0.02, texel.a);
        float validAlpha = smoothstep(0.15, 0.92, texel.a);
        return vec4(unpremultRgb, validAlpha * feather);
      }

      vec3 evalScientificFilter(
        float mode,
        vec4 s,
        float cloudRaw,
        vec3 crispLand,
        vec3 slateLand,
        vec3 deepOcean,
        float landMask,
        float waterMask,
        float reliefMod,
        float filterSunFloor,
        vec3 albedo,
        vec3 cityLights
      ) {
        float sa = clamp(s.a, 0.0, 1.0);
        if (mode < 1.5) {
          // 1.0: GEOS / MERRA-2 Surface Winds (natural continents + deep sapphire calm seas + glowing wind belts)
          vec3 windRgb = (s.rgb / (1.0 + s.rgb * 0.12)) * 1.14;
          vec3 landWinds = mix(crispLand, windRgb * reliefMod, 0.20 * sa);
          float windEnergy = max(s.r - s.g * 0.92, (0.82 - s.g) * 1.3) + max(0.0, s.b - s.g) * 0.8;
          float windSignal = smoothstep(0.03, 0.34, windEnergy);
          vec3 calmSea = mix(deepOcean, vec3(0.06, 0.24, 0.56) * reliefMod, 0.42);
          vec3 oceanWinds = mix(calmSea, windRgb, windSignal * sa);
          oceanWinds = mix(oceanWinds, vec3(0.92, 0.96, 1.0), smoothstep(0.62, 0.94, cloudRaw) * 0.32 * waterMask);
          return mix(oceanWinds, landWinds, landMask) * filterSunFloor;
        }
        if (mode < 2.5) {
          // 2.0: GEOS / IMERG Precipitable Water & Rain (key dry cream air over slate land & sapphire ocean + storm tops)
          float isDryCream = smoothstep(0.30, 0.04, abs(s.r - s.g) + max(0.0, 0.78 - s.g));
          vec3 dryBase = mix(deepOcean, slateLand, landMask);
          vec3 moistBand = (s.rgb / (1.0 + s.rgb * 0.10)) * 1.10 * reliefMod;
          vec3 precipCol = mix(dryBase, mix(moistBand, dryBase, isDryCream), 0.92 * sa);
          float cloudTops = smoothstep(0.48, 0.88, cloudRaw) * (1.0 - isDryCream * 0.65);
          precipCol = mix(precipCol, vec3(0.96, 0.98, 1.0) * reliefMod, cloudTops * 0.82);
          return precipCol * filterSunFloor;
        }
        if (mode < 3.5) {
          // 3.0: Thermal Skin Temp (MUR SST + MODIS LST with subtle bathymetry & mountain relief)
          vec3 thermalRgb = (s.rgb / (1.0 + s.rgb * 0.10)) * 1.06 * reliefMod;
          return mix(mix(deepOcean, crispLand, landMask), thermalRgb, sa * 0.90) * filterSunFloor;
        }
        if (mode < 4.5) {
          // 4.0: Ocean Temp Anomaly (key neutral ~0°C linear ~(0.59,0.59,0.47) into deep sapphire ocean)
          float cMax = max(s.r, max(s.g, s.b));
          float cMin = min(s.r, min(s.g, s.b));
          float chroma = cMax - cMin;
          float anomalyStrength = chroma + max(0.0, 0.40 - cMin) * 1.35;
          float anomalyMask = smoothstep(0.20, 0.50, anomalyStrength);
          float warmCore = smoothstep(0.20, 0.60, s.r - s.g) * smoothstep(0.30, 0.04, s.g);
          float extremeHot = smoothstep(0.45, 0.18, s.r) * step(0.18, s.r) * smoothstep(0.04, 0.0, s.g) * smoothstep(0.08, 0.0, s.b);
          vec3 sstRgb = s.rgb;
          sstRgb = mix(sstRgb, vec3(0.92, 0.05, 0.10), extremeHot * 0.72);
          sstRgb.b = mix(sstRgb.b, sstRgb.b * 0.55, warmCore * 0.65);
          sstRgb.g = mix(sstRgb.g, max(sstRgb.g, sstRgb.r * 0.12), warmCore * 0.45);
          sstRgb = (sstRgb / (1.0 + sstRgb * 0.14)) * 1.10;
          vec3 sstSea = mix(deepOcean, sstRgb * reliefMod, sa * anomalyMask * 0.90);
          return mix(sstSea, crispLand, landMask) * filterSunFloor;
        }
        if (mode < 5.5) {
          // 5.0: 2m Air Temperature (MERRA-2 with subtle bathymetry & mountain relief)
          vec3 airRgb = (s.rgb / (1.0 + s.rgb * 0.10)) * 1.06 * reliefMod;
          return mix(mix(deepOcean, crispLand, landMask), airRgb, sa * 0.88) * filterSunFloor;
        }
        if (mode < 6.5) {
          // 6.0: Aerosols, Smoke & Dust (key out low-AOD background so plumes pop cleanly)
          float plumeMask = smoothstep(0.01, 0.30, s.r - s.b * 0.85) * 0.90 * sa;
          vec3 cleanBase = mix(deepOcean, crispLand, landMask);
          vec3 plumeRgb = (s.rgb / (1.0 + s.rgb * 0.10)) * 1.10 * reliefMod;
          return mix(cleanBase, plumeRgb, plumeMask) * filterSunFloor;
        }
        if (mode < 7.5) {
          // 7.0: Vegetation Canopy (MODIS 250m NDVI over continents + deep sapphire ocean)
          vec3 ndviLand = mix(crispLand, s.rgb * reliefMod * 1.04, sa * 0.90);
          return mix(deepOcean, ndviLand, landMask) * filterSunFloor;
        }
        if (mode < 8.5) {
          // 8.0: Satellite True Color + Clouds (MODIS — fill narrow equatorial swath gaps with 4K Blue Marble)
          float swathValid = smoothstep(0.008, 0.045, max(s.r, max(s.g, s.b))) * sa;
          return mix(mix(deepOcean, crispLand, landMask), s.rgb * reliefMod, swathValid) * filterSunFloor;
        }
        // 9.0: Night Radiance (VIIRS Black Marble)
        return albedo * 0.035 + s.rgb * 1.35 + cityLights * 0.65;
      }

      void main() {
        bool isDetailCap = vDetailMerc.z > 0.5;
        if (isDetailCap && vDetailMerc.w <= 0.001) discard;
        vec3 N0 = normalize(vWorldNormal);
        float specSample = texture2D(uWaterMap, vUv).r;
        float waterMask = smoothstep(0.24, 0.72, specSample);
        float landMask = 1.0 - waterMask;

        // Right-handed spherical tangent frame: +u = east, +v = north, +z = N0
        float sinPhi = clamp(length(vec2(N0.x, N0.z)), 0.0, 1.0);
        float poleFade = smoothstep(0.05, 0.24, sinPhi);
        vec3 east = sinPhi > 0.001 ? normalize(vec3(N0.z, 0.0, -N0.x)) : vec3(1.0, 0.0, 0.0);
        vec3 north = normalize(cross(N0, east));

        // Combine 2K normal map with subtle ocean capillary ripple micro-normals
        vec3 nMap = texture2D(uNormalMap, vUv).xyz * 2.0 - 1.0;
        float w1 = noise3(N0 * 78.0);
        float w2 = noise3(N0 * 78.0 + vec3(0.08, 0.0, 0.08));
        vec3 waterRipple = (east * (w2 - w1) + north * (w1 - 0.5)) * (0.045 * waterMask * poleFade);
        float landReliefScale = 1.35 * landMask * poleFade;
        vec3 N = normalize(
          N0 +
          east * (nMap.x * landReliefScale) +
          north * (nMap.y * landReliefScale) +
          waterRipple
        );

        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 L_daylight = normalize(V + vec3(0.22, 0.36, 0.14));
        vec3 L = normalize(mix(L_daylight, normalize(uSunDir), uDayNightEnabled));
        float NdotV = max(dot(N0, V), 0.0);
        float sphereSunDot = dot(N0, L);
        float normalSunDot = max(dot(N, L), 0.0);
        float wrappedSun = max((dot(N, L) + 0.06) / 1.06, 0.0);

        // Sample drifting 3D cloud deck overhead + solar shadow projection onto planet surface
        float sunEast = dot(east, L);
        float sunNorth = dot(north, L);
        vec2 cloudUvAbove = vec2(fract(vUv.x - uCloudDriftU), clamp(vUv.y, 0.002, 0.998));
        float cloudAbove = smoothstep(0.14, 0.90, texture2D(uCloudMap, cloudUvAbove).a) * smoothstep(0.03, 0.16, sinPhi) * uCloudsEnabled;

        // Project cloud shadow opposite the solar tangent (stronger at oblique grazing sun angles)
        float obliquity = mix(0.0024, 0.0068, 1.0 - clamp(sphereSunDot, 0.0, 1.0));
        vec2 cloudShadowUv = vec2(
          fract(vUv.x - uCloudDriftU + sunEast * obliquity),
          clamp(vUv.y + sunNorth * obliquity, 0.002, 0.998)
        );
        float cloudShadowSample = texture2D(uCloudMap, cloudShadowUv).a;
        float cloudShadow = smoothstep(0.18, 0.92, cloudShadowSample) * smoothstep(0.03, 0.16, sinPhi) * smoothstep(-0.02, 0.35, sphereSunDot) * uCloudsEnabled;

        // Atmospheric Mie extinction along the terminator turns low sun rays golden-copper
        float daylightTerm = mix(1.0, smoothstep(-0.06, 0.42, sphereSunDot), uDayNightEnabled);
        float twilightBell = exp(-pow((sphereSunDot + 0.015) * 6.8, 2.0)) * uDayNightEnabled;
        vec3 directSolarTint = mix(
          vec3(1.02, 1.00, 0.98),
          mix(vec3(1.0, 0.56, 0.28), vec3(1.04, 1.01, 0.97), smoothstep(0.0, 0.36, sphereSunDot)),
          uDayNightEnabled
        );

        vec3 albedo = texture2D(uDayMap, vUv).rgb;
        // Deepen pelagic ocean sapphire while keeping continental shelves & turquoise atolls luminous
        albedo = mix(albedo, albedo * vec3(0.76, 0.88, 1.08), waterMask * 0.36);

        // Diffuse reflectance (shadowed beneath 3D clouds)
        float directAtten = wrappedSun * (1.0 - cloudShadow * 0.40) * daylightTerm;
        vec3 ambientSky = albedo * mix(
          vec3(0.24, 0.26, 0.31),
          mix(vec3(0.009, 0.014, 0.028), vec3(0.035, 0.055, 0.095), smoothstep(-0.18, 0.45, sphereSunDot)),
          uDayNightEnabled
        );
        float diffuseScale = mix(0.86, 1.16, uDayNightEnabled);
        vec3 diffuse = albedo * directSolarTint * directAtten * diffuseScale + ambientSky;

        // Dual-lobe solar ocean sunglint + ocean Fresnel sky reflection (occluded by clouds!)
        vec3 H = normalize(L + V);
        float NdotH = max(dot(normalize(mix(N0, N, 0.35)), H), 0.0);
        float sunVisibility = mix(0.32, smoothstep(-0.02, 0.26, sphereSunDot), uDayNightEnabled) * (1.0 - cloudShadow * 0.72);
        float tightGlint = pow(NdotH, 340.0) * 1.05;
        float waveScatter = pow(NdotH, 26.0) * 0.085;
        vec3 solarGlint = vec3(1.0, 0.95, 0.86) * (tightGlint + waveScatter) * waterMask * sunVisibility;

        float fresnel = pow(1.0 - NdotV, 4.4);
        vec3 oceanSkyRefl = vec3(0.14, 0.38, 0.72) * fresnel * waterMask * mix(1.0, smoothstep(-0.18, 0.55, sphereSunDot), uDayNightEnabled) * 0.28;

        // Rayleigh sunlit horizon scatter & warm Mie sunset glow right across the terminator
        float horizonRim = pow(1.0 - NdotV, 3.2);
        vec3 rayleighVeil = vec3(0.24, 0.54, 0.96) * horizonRim * mix(0.85, smoothstep(-0.08, 0.58, sphereSunDot), uDayNightEnabled) * 0.34;
        vec3 mieTerminator = vec3(0.98, 0.44, 0.14) * twilightBell * (0.09 + 0.16 * landMask + 0.22 * horizonRim);

        // Crisp VIIRS Night City Lights on dark hemisphere (occluded gently under dense clouds)
        float nightMask = smoothstep(0.08, -0.22, sphereSunDot) * uDayNightEnabled;
        vec3 lights2k = texture2D(uLightsMap, vUv).rgb;
        vec3 nightBg = texture2D(uNightMap, vUv).rgb;
        float warmLegacy = max(0.0, nightBg.r - nightBg.b * 0.65);
        vec3 citySignal = max(lights2k * 1.15, vec3(warmLegacy) * 0.7);
        float cityLuma = dot(citySignal, vec3(0.35, 0.45, 0.2));
        vec3 cityLights =
          vec3(1.0, 0.76, 0.42) *
          smoothstep(0.06, 0.68, cityLuma) *
          1.65 *
          nightMask *
          (1.0 - waterMask * 0.88) *
          (1.0 - cloudAbove * 0.62);

        vec3 finalColor = diffuse + solarGlint + oceanSkyRefl + rayleighVeil + mieTerminator + cityLights;

        // Blend full-sphere NASA SVS / GEOS-5 style scientific filter or 4-slice composite
        if (uGlobalLayerBlend > 0.001 && uGlobalFilterMode > 0.5) {
          float filterSunFloor = mix(1.0, mix(0.84, 1.05, smoothstep(-0.25, 0.45, sphereSunDot)), uDayNightEnabled);
          float reliefMod = mix(0.90, 1.12, clamp(dot(N, L_daylight) * 0.65 + 0.35, 0.0, 1.0));
          float filterWaterMask = smoothstep(0.36, 0.56, specSample);
          float filterLandMask = 1.0 - filterWaterMask;
          vec3 deepOcean = mix(albedo * vec3(0.45, 0.68, 1.05), vec3(0.035, 0.115, 0.34), 0.72) * reliefMod;
          vec3 crispLand = albedo * reliefMod * 1.04;
          vec3 slateLand = mix(vec3(dot(albedo, vec3(0.3, 0.59, 0.11)) * 0.92), albedo, 0.22) * reliefMod;
          float cloudRaw = texture2D(uCloudMap, cloudUvAbove).a;

          vec3 globalColor;
          if (uGlobalFilterMode > 9.5) {
            // 10.0: 4-Slice NASA SVS Showcase (Canopy | Winds | Precipitable Water | Satellite Clouds)
            float viewX = dot(N0, normalize(uCameraRight));
            if (viewX < -0.34) {
              globalColor = mix(deepOcean, crispLand * vec3(0.92, 1.12, 0.88), filterLandMask) * filterSunFloor;
            } else if (viewX < 0.0) {
              vec4 sw = sampleGlobalField(uSliceWindsMap, vUv, vec2(2560.0, 1280.0), sinPhi, 1.15 * uFilterSmooth);
              globalColor = evalScientificFilter(1.0, sw, cloudRaw, crispLand, slateLand, deepOcean, filterLandMask, filterWaterMask, reliefMod, filterSunFloor, albedo, cityLights);
            } else if (viewX < 0.34) {
              vec4 sp = sampleGlobalField(uSlicePrecipMap, vUv, vec2(2560.0, 1280.0), sinPhi, 0.90 * uFilterSmooth);
              globalColor = evalScientificFilter(2.0, sp, cloudRaw, crispLand, slateLand, deepOcean, filterLandMask, filterWaterMask, reliefMod, filterSunFloor, albedo, cityLights);
            } else {
              vec4 sc = texture2D(uSliceCloudsMap, vUv);
              globalColor = evalScientificFilter(8.0, sc, cloudRaw, crispLand, slateLand, deepOcean, filterLandMask, filterWaterMask, reliefMod, filterSunFloor, albedo, cityLights);
            }
            float d1 = abs(viewX + 0.34);
            float d2 = abs(viewX);
            float d3 = abs(viewX - 0.34);
            float seam = smoothstep(0.009, 0.002, min(d1, min(d2, d3)));
            globalColor = mix(globalColor, vec3(0.86, 0.92, 0.98), seam * 0.72);
          } else {
            vec4 globalSample = sampleGlobalField(
              uGlobalLayerMap,
              vUv,
              uGlobalTexSize,
              sinPhi,
              filterSmoothRadius(uGlobalFilterMode) * uFilterSmooth
            );
            globalColor = evalScientificFilter(
              uGlobalFilterMode,
              globalSample,
              cloudRaw,
              crispLand,
              slateLand,
              deepOcean,
              filterLandMask,
              filterWaterMask,
              reliefMod,
              filterSunFloor,
              albedo,
              cityLights
            );
          }

          if (uBordersLoaded > 0.5) {
            vec4 bdr = texture2D(uBordersMap, vUv);
            vec3 borderTint = (uGlobalFilterMode > 8.5 && uGlobalFilterMode < 9.5)
              ? vec3(0.48, 0.56, 0.68)
              : vec3(0.07, 0.10, 0.15);
            globalColor = mix(globalColor, borderTint, bdr.a * 0.78);
          }

          finalColor = mix(finalColor, globalColor + rayleighVeil * 0.28, uGlobalLayerBlend);
        }

        // Blend 4-tier progressive Web Mercator satellite photography pyramid (coarse -> mid -> prevFine -> fine)
        if (
          uSatCoarseBlend > 0.001 ||
          uSatMidBlend > 0.001 ||
          uSatPrevFineBlend > 0.001 ||
          uSatFineBlend > 0.001
        ) {
          float fragLng = fract(vUv.x) * 360.0 - 180.0;
          float fragLat = vUv.y * 180.0 - 90.0;
          float satIllum = mix(1.0, mix(0.80, 1.04, smoothstep(-0.25, 0.42, sphereSunDot)), uDayNightEnabled);
          if (uSatCoarseBlend > 0.001) {
            vec4 coarseSample = sampleAerialMercatorPatch(uSatCoarseMap, uSatCoarseMercBounds, uSatCoarseRelBounds, fragLng, fragLat, vDetailMerc);
            if (coarseSample.a > 0.001) {
              vec3 coarseColor = coarseSample.rgb * satIllum + rayleighVeil * 0.20;
              finalColor = mix(finalColor, coarseColor, coarseSample.a * uSatCoarseBlend);
            }
          }
          if (uSatMidBlend > 0.001) {
            vec4 midSample = sampleAerialMercatorPatch(uSatMidMap, uSatMidMercBounds, uSatMidRelBounds, fragLng, fragLat, vDetailMerc);
            if (midSample.a > 0.001) {
              vec3 midColor = midSample.rgb * satIllum + rayleighVeil * 0.20;
              finalColor = mix(finalColor, midColor, midSample.a * uSatMidBlend);
            }
          }
          if (uSatPrevFineBlend > 0.001) {
            vec4 prevFineSample = sampleAerialMercatorPatch(uSatPrevFineMap, uSatPrevFineMercBounds, uSatPrevFineRelBounds, fragLng, fragLat, vDetailMerc);
            if (prevFineSample.a > 0.001) {
              vec3 prevFineColor = prevFineSample.rgb * satIllum + rayleighVeil * 0.20;
              finalColor = mix(finalColor, prevFineColor, prevFineSample.a * uSatPrevFineBlend);
            }
          }
          if (uSatFineBlend > 0.001) {
            vec4 fineSample = sampleAerialMercatorPatch(uSatFineMap, uSatFineMercBounds, uSatFineRelBounds, fragLng, fragLat, vDetailMerc);
            if (fineSample.a > 0.001) {
              vec3 fineColor = fineSample.rgb * satIllum + rayleighVeil * 0.20;
              finalColor = mix(finalColor, fineColor, fineSample.a * uSatFineBlend);
            }
          }
        }

        // Blend live NASA GIBS regional satellite / thermal / NDVI / night swath seamlessly
        if (uRegionalBlend > 0.001) {
          float fragLng = fract(vUv.x) * 360.0 - 180.0;
          float fragLat = vUv.y * 180.0 - 90.0;
          vec2 regUv = vec2(
            (fragLng - uRegionalBounds.x) / max(0.001, uRegionalBounds.z - uRegionalBounds.x),
            (fragLat - uRegionalBounds.y) / max(0.001, uRegionalBounds.w - uRegionalBounds.y)
          );
          if (regUv.x > 0.0 && regUv.x < 1.0 && regUv.y > 0.0 && regUv.y < 1.0) {
            float edgeDist = min(min(regUv.x, 1.0 - regUv.x), min(regUv.y, 1.0 - regUv.y));
            float feather = smoothstep(0.0, 0.085, edgeDist) * uRegionalBlend * uRegionalMaxOpacity;
            vec3 gibsSample = texture2D(uRegionalMap, regUv).rgb;
            float inspectIllum = mix(0.82, 1.06, smoothstep(-0.15, 0.45, sphereSunDot));
            float reliefMod = mix(0.94, 1.08, clamp(normalSunDot * 0.65 + 0.35, 0.0, 1.0));
            vec3 naturalRegional = gibsSample * inspectIllum * reliefMod + rayleighVeil * 0.35;
            vec3 dataRegional = gibsSample * 1.02 + rayleighVeil * 0.18;
            vec3 regionalColor = mix(naturalRegional, dataRegional, uRegionalDataMode);
            finalColor = mix(finalColor, regionalColor, feather);
          }
        }

        float outAlpha = isDetailCap ? vDetailMerc.w : 1.0;
        gl_FragColor = vec4(finalColor, outAlpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
}

/**
 * 2. Crisp Fibrous 3D Cloud Deck (indexed PNG .a enhanced with seamless 3D FBM detail).
 */
export function createCloudDeckMaterial(params: {
  cloudsTex: THREE.Texture;
  sunDirection: THREE.Vector3;
  dayNightEnabledUniform: THREE.IUniform;
}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCloudMap: { value: params.cloudsTex },
      uSunDir: { value: params.sunDirection.clone() },
      uDayNightEnabled: params.dayNightEnabledUniform,
      uRegionalFade: { value: 1.0 },
    },
    vertexShader: `
      attribute vec4 aDetailMerc;
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      varying vec4 vDetailMerc;
      void main() {
        vUv = uv;
        vDetailMerc = aDetailMerc;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uCloudMap;
      uniform vec3 uSunDir;
      uniform float uDayNightEnabled;
      uniform float uRegionalFade;
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;

      ${GLSL_NOISE_HELPERS}

      float fbm(vec3 p) {
        return 0.65 * noise3(p) + 0.35 * noise3(p * 2.15 + 4.3);
      }

      void main() {
        vec3 wn = normalize(vWorldNormal);
        float sinPhiC = clamp(length(vec2(wn.x, wn.z)), 0.0, 1.0);
        float rawCloud = texture2D(uCloudMap, vUv).a;
        float fineWisp = fbm(wn * 22.0);
        float sculpted = clamp(rawCloud * (0.78 + 0.42 * fineWisp), 0.0, 1.0);
        float cloudDensity = smoothstep(0.12, 0.90, sculpted) * smoothstep(0.03, 0.16, sinPhiC);

        vec3 L = normalize(uSunDir);
        float sunTerm = dot(wn, L);
        float dayFade = mix(1.0, smoothstep(-0.14, 0.48, sunTerm), uDayNightEnabled);
        float sunsetBand = exp(-pow((sunTerm + 0.01) * 7.2, 2.0)) * uDayNightEnabled;

        vec3 cloudRgb = mix(vec3(0.06, 0.09, 0.16), vec3(0.97, 0.985, 1.0), dayFade);
        cloudRgb = mix(cloudRgb, vec3(1.0, 0.62, 0.34), sunsetBand * 0.55);

        float alpha = cloudDensity * mix(0.14, 0.44, dayFade) * uRegionalFade;
        gl_FragColor = vec4(cloudRgb, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
  });
}

/**
 * 4a. Subtle Inner Atmospheric Limb Sheen (day-weighted).
 */
export function createInnerHazeMaterial(params: {
  sunDirUniform: THREE.IUniform;
  dayNightEnabledUniform: THREE.IUniform;
}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: params.sunDirUniform,
      uDayNightEnabled: params.dayNightEnabledUniform,
      uInnerHazeFade: { value: 1.0 },
    },
    vertexShader: `
      varying vec3 vWorldNormal;
      varying vec3 vViewPos;
      void main() {
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir;
      uniform float uDayNightEnabled;
      uniform float uInnerHazeFade;
      varying vec3 vWorldNormal;
      varying vec3 vViewPos;
      void main() {
        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(cameraPosition - N * ${EARTH_RADIUS.toFixed(1)});
        float rim = 1.0 - max(dot(N, V), 0.0);
        float sunSide = mix(1.0, smoothstep(-0.28, 0.62, dot(N, normalize(uSunDir))), uDayNightEnabled);
        float alpha = pow(rim, 4.0) * (0.04 + 0.28 * sunSide) * uInnerHazeFade;
        gl_FragColor = vec4(0.32, 0.70, 1.0, alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

/**
 * 4b. Outer Rayleigh & Sunset Atmospheric Crescent Limb (sunlit-modulated).
 */
export function createOuterAtmosphereMaterial(params: {
  sunDirection: THREE.Vector3;
  dayNightEnabledUniform: THREE.IUniform;
}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: params.sunDirection.clone() },
      uDayNightEnabled: params.dayNightEnabledUniform,
    },
    vertexShader: `
      varying vec3 vViewNormal;
      varying vec3 vWorldNormal;
      void main() {
        vViewNormal = normalize(normalMatrix * normal);
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uSunDir;
      uniform float uDayNightEnabled;
      varying vec3 vViewNormal;
      varying vec3 vWorldNormal;
      void main() {
        float rim = pow(clamp(0.64 - dot(normalize(vViewNormal), vec3(0.0, 0.0, 1.0)), 0.0, 1.0), 3.4);
        float sunDot = dot(normalize(vWorldNormal), normalize(uSunDir));
        float sunlit = mix(1.0, smoothstep(-0.36, 0.62, sunDot), uDayNightEnabled);
        float sunsetEdge = exp(-pow(sunDot * 5.2, 2.0)) * uDayNightEnabled;
        vec3 limbColor = mix(vec3(0.24, 0.62, 1.0), vec3(0.98, 0.48, 0.20), sunsetEdge * 0.58);
        float intensity = rim * (0.07 + 0.92 * sunlit);
        gl_FragColor = vec4(limbColor, 1.0) * intensity * 0.92;
      }
    `,
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}
