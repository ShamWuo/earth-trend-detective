import type { ETGResearchDossier, ETGScientificCitation } from "@/types/etg";

export const VERIFIED_CITATIONS = {
  rantanen2022Arctic: {
    title: "The Arctic has warmed nearly four times faster than the globe since 1979",
    authors: "Rantanen, M., Karpechko, A. Y., Lipponen, A., Nordling, K., Hyvärinen, O., Ruosteenoja, K., Vihma, T., & Laaksonen, A.",
    journal: "Communications Earth & Environment",
    year: 2022,
    doi: "10.1038/s43247-022-00498-3",
    url: "https://doi.org/10.1038/s43247-022-00498-3",
    source: "curated",
  },
  garreaud2020Chile: {
    title: "The Central Chile Mega Drought (2010–2018): A climate dynamics perspective",
    authors: "Garreaud, R. D., Boisier, J. P., Rondanelli, R., Montecinos, A., Sepúlveda, H. H., & Veloso-Aguila, D.",
    journal: "International Journal of Climatology",
    year: 2020,
    doi: "10.1002/joc.6219",
    url: "https://doi.org/10.1002/joc.6219",
    source: "curated",
  },
  caesar2018Amoc: {
    title: "Observed fingerprint of a weakening Atlantic Ocean overturning circulation",
    authors: "Caesar, L., Rahmstorf, S., Robinson, A., Feulner, G., & Saba, V. S.",
    journal: "Nature",
    year: 2018,
    doi: "10.1038/s41586-018-0006-5",
    url: "https://doi.org/10.1038/s41586-018-0006-5",
    source: "curated",
  },
  williams2022Megadrought: {
    title: "Rapid intensification of the emerging southwestern North American megadrought in 2020–2021",
    authors: "Williams, A. P., Cook, B. I., & Smerdon, J. E.",
    journal: "Nature Climate Change",
    year: 2022,
    doi: "10.1038/s41558-022-01290-z",
    url: "https://doi.org/10.1038/s41558-022-01290-z",
    source: "curated",
  },
  jain2022FireWeather: {
    title: "Observed increases in extreme fire weather driven by atmospheric humidity and temperature",
    authors: "Jain, P., Castellanos-Acuna, D., Coogan, S. C. P., Abatzoglou, J. T., & Flannigan, M. D.",
    journal: "Nature Climate Change",
    year: 2022,
    doi: "10.1038/s41558-021-01224-1",
    url: "https://doi.org/10.1038/s41558-021-01224-1",
    source: "curated",
  },
  saji1999Iod: {
    title: "A dipole mode in the tropical Indian Ocean",
    authors: "Saji, N. H., Goswami, B. N., Vinayachandran, P. N., & Yamagata, T.",
    journal: "Nature",
    year: 1999,
    doi: "10.1038/43854",
    url: "https://doi.org/10.1038/43854",
    source: "curated",
  },
  funk2008EastAfrica: {
    title: "Warming of the Indian Ocean threatens eastern and southern African food security but could be mitigated by agricultural development",
    authors: "Funk, C., Dettinger, M. D., Michaelsen, J. C., Verdin, J. P., Brown, M. E., Barlow, M., & Hoell, A.",
    journal: "Proceedings of the National Academy of Sciences (PNAS)",
    year: 2008,
    doi: "10.1073/pnas.0708196105",
    url: "https://doi.org/10.1073/pnas.0708196105",
    source: "curated",
  },
  feng2021ArcticRivers: {
    title: "Recent changes to Arctic river discharge",
    authors: "Feng, D., Gleason, C. J., Lin, P., Yang, X., Pan, M., & Ishitsuka, Y.",
    journal: "Nature Communications",
    year: 2021,
    doi: "10.1038/s41467-021-27228-1",
    url: "https://doi.org/10.1038/s41467-021-27228-1",
    source: "curated",
  },
  ipccAr6Wg1: {
    title: "Climate Change 2021: The Physical Science Basis (AR6 Working Group I Contribution)",
    authors: "IPCC (Masson-Delmotte, V., Zhai, P., et al., Eds.)",
    journal: "Cambridge University Press",
    year: 2021,
    doi: "10.1017/9781009157896",
    url: "https://doi.org/10.1017/9781009157896",
    abstract_snippet:
      "IPCC Sixth Assessment Report (AR6 WG1) establishes that human-induced greenhouse gas emissions have unequivocally warmed the global surface, driving amplified Arctic warming, accelerating sea-ice and glacier retreat, increasing vapor pressure deficit, altering ocean heat uptake and AMOC stability, and intensifying regional droughts, river discharge shifts, and extreme heat events.",
    source: "curated",
  },
} satisfies Record<string, ETGScientificCitation>;

/**
 * Strips trailing raw GDACS/EONET numeric event identifiers (e.g. `1033825`, `1104280`)
 * and normalizes punctuation without truncating words mid-syllable.
 */
export function cleanEonetEventTitle(rawTitle: string): string {
  const cleaned = rawTitle
    .replace(/\s+\b\d{5,9}\b\s*$/g, "")
    .replace(/\s+\bGDACS[-_\s]*\d+\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || rawTitle.trim();
}

/**
 * Maps geographic coordinates to clean climatological basin/region names
 * when upstream titles are noisy, coordinate-only, or truncated.
 */
export function resolveNamedEarthRegion(
  lat: number,
  lng: number,
  fallbackTitle?: string
): string {
  if (lat >= -22 && lat <= -10 && lng >= 115 && lng <= 135) {
    return "Kimberley & Northern Australia";
  }
  if (lat >= -40 && lat <= -25 && lng >= 114 && lng <= 155) {
    return "Southern & Eastern Australia";
  }
  if (lat >= -28 && lat <= -11 && lng >= 42 && lng <= 52) {
    return "Madagascar & SW Indian Ocean";
  }
  if (lat >= -37 && lat <= -28 && lng >= -74 && lng <= -68) {
    return "Central Chile & Southern Andes";
  }
  if (lat >= -45 && lat <= -35 && lng >= -75 && lng <= -67) {
    return "Northern Patagonia & Southern Andes";
  }
  if (lat >= 30 && lat <= 42 && lng >= -124 && lng <= -103) {
    return "Southwestern North America & Colorado Basin";
  }
  if (lat >= 15 && lat <= 26 && lng >= 92 && lng <= 102) {
    return "Myanmar & Irrawaddy Basin";
  }
  if (lat >= -6 && lat <= 12 && lng >= 32 && lng <= 52) {
    return "Greater Horn of Africa";
  }
  if (lat >= -10 && lat <= 8 && lng >= 95 && lng <= 145) {
    return "Indo-Pacific Warm Pool / Maritime Continent";
  }
  if (lat >= 46 && lat <= 62 && lng >= -50 && lng <= -20) {
    return "Subpolar North Atlantic Gyre";
  }
  if (lat >= 64) {
    return "Pan-Arctic Polar Belt (64°N–90°N)";
  }
  if (fallbackTitle) {
    const clean = cleanEonetEventTitle(fallbackTitle);
    if (clean.length > 0 && clean.length <= 64) return clean;
  }
  return `${lat.toFixed(2)}°, ${lng.toFixed(2)}°`;
}

export function buildArcticAmplificationDossier(params: {
  arcticSlope: number;
  arcticP: number;
  globalSlope: number;
  globalP: number;
  ampRatio: number;
  seaIceSlope: number;
  seaIceP: number;
  co2ArcticR: number;
  co2SeaIceR: number;
  updatedAt: string;
}): ETGResearchDossier {
  const {
    arcticSlope,
    arcticP,
    globalSlope,
    globalP,
    ampRatio,
    seaIceSlope,
    seaIceP,
    co2ArcticR,
    co2SeaIceR,
    updatedAt,
  } = params;
  return {
    abstract: `High-latitude NASA GISTEMP 64°N–90°N surface warming (+${arcticSlope.toFixed(4)} °C/yr, p=${arcticP.toFixed(4)}) exceeds the global mean (+${globalSlope.toFixed(4)} °C/yr, p=${globalP.toFixed(4)}) by ${ampRatio.toFixed(2)}× across the 1995–present overlapping record, tightly coupled to September Arctic sea-ice extent decline (${seaIceSlope.toFixed(4)}M km²/yr, p=${seaIceP.toFixed(4)}).`,
    physical_mechanism:
      "Ice-albedo positive feedback reduces surface solar reflectivity as bright multi-year sea ice gives way to dark open ocean, amplifying sensible heat flux, water-vapor feedback, and lapse-rate feedback across the stable Arctic boundary layer.",
    empirical_findings: [
      `[signal-gistemp-64n-90n] warms at +${arcticSlope.toFixed(4)} °C/yr (MK p=${arcticP.toFixed(4)}) vs. [signal-gistemp-global] at +${globalSlope.toFixed(4)} °C/yr (p=${globalP.toFixed(4)}) -> ${ampRatio.toFixed(2)}× Polar Amplification.`,
      `[signal-nsidc-arctic-seaice] September minimum extent contracts at ${seaIceSlope.toFixed(4)} million km²/yr (MK p=${seaIceP.toFixed(4)}).`,
      `[signal-noaa-global-co2] Mauna Loa CO₂ tracks [signal-gistemp-64n-90n] at r=${co2ArcticR.toFixed(2)} and inversely mirrors [signal-nsidc-arctic-seaice] at r=${co2SeaIceR.toFixed(2)}.`,
      "Surface stations [signal-noaa-cdo-usw00027502] (NOAA CDO Alaska) and [signal-geoca-ahccd-2400573] (CSA AHCCD Nunavut) independently corroborate high-latitude warming.",
    ],
    impacts: [
      "Accelerated permafrost thaw and basal carbon mineralization across circum-Arctic peatlands.",
      "Amplified coastal wave erosion in Chukchi/Beaufort shelves as open-water fetch lengthens into autumn.",
      "Reduced meridional temperature gradient altering planetary Rossby-wave persistence.",
    ],
    citations: [VERIFIED_CITATIONS.rantanen2022Arctic, VERIFIED_CITATIONS.ipccAr6Wg1],
    markdown_body: `### Supersession of Early-2000s 2× Amplification Estimates

Early satellite-era syntheses estimated Arctic warming at roughly twice the global average. Recomputing Hamed-Rao Mann-Kendall and Theil-Sen slopes on live NASA GISTEMP v4 zonal bands shows an amplification factor of **${ampRatio.toFixed(2)}×**, consistent with Rantanen et al. (2022), who demonstrated that the Arctic has warmed nearly four times faster than the globe since 1979.

### Multi-Agency Telemetry Convergence

This conclusion satisfies ETG multi-source corroboration across four independent observing architectures: (1) NASA GISTEMP v4 zonal anomalies, (2) NOAA/NSIDC passive-microwave Sea Ice Index v4, (3) NOAA NCEI ground station records at Utqiagvik, and (4) CSA Geo.ca homogenized Canadian Arctic records at Clyde River.`,
    updated_at: updatedAt,
    researched_by: "agency_curation",
  };
}

export function buildGlobalCo2WarmingDossier(params: {
  co2Slope: number;
  co2P: number;
  globalSlope: number;
  globalP: number;
  co2GlobalR: number;
  updatedAt: string;
}): ETGResearchDossier {
  const { co2Slope, co2P, globalSlope, globalP, co2GlobalR, updatedAt } = params;
  return {
    abstract: `Well-mixed atmospheric CO₂ at NOAA Mauna Loa (+${co2Slope.toFixed(3)} ppm/yr, p=${co2P.toFixed(4)}) exhibits monotonic radiative forcing coupling (r=${co2GlobalR.toFixed(2)}) with global mean surface temperature anomaly [signal-gistemp-global] (+${globalSlope.toFixed(4)} °C/yr, p=${globalP.toFixed(4)}).`,
    physical_mechanism:
      "Longwave infrared absorption by rising well-mixed greenhouse gases reduces outgoing top-of-atmosphere radiative cooling, raising global radiative imbalance (~+0.8 to +1.0 W/m² net flux) and driving equilibrium ocean heat uptake and tropospheric warming.",
    empirical_findings: [
      `[signal-noaa-global-co2] rises monotonically at +${co2Slope.toFixed(3)} ppm/yr (MK p=${co2P.toFixed(4)}).`,
      `[signal-gistemp-global] warms at +${globalSlope.toFixed(4)} °C/yr (MK p=${globalP.toFixed(4)}), correlated at r=${co2GlobalR.toFixed(2)}.`,
      "Sub-band GISTEMP signals confirm global-scale radiative coherence tempered regionally by ocean circulation and land-surface moisture.",
    ],
    impacts: [
      "Sets the secular thermal baseline upon which regional synoptic oscillations (ENSO, NAO, IOD, AMO) superpose.",
      "Elevates atmospheric saturation vapor pressure via Clausius-Clapeyron (~7%/°C), intensifying both extreme precipitation and evaporative demand.",
    ],
    citations: [VERIFIED_CITATIONS.ipccAr6Wg1],
    markdown_body: `### Secular Baseline vs. Interannual Variability

In the ETG Trend Microscope, differentiating well-mixed secular CO₂ forcing from internal variability (ENSO, IOD, NAO) prevents spurious attribution: **correlated long-term drift** is anchored to [signal-noaa-global-co2], whereas cross-region dynamical dipoles must pass **detrended or lagged residual coupling** screening.`,
    updated_at: updatedAt,
    researched_by: "agency_curation",
  };
}

export function buildChileMegadroughtDossier(params: {
  precipSlope: number;
  precipP: number;
  rhSlope: number;
  rhP: number;
  t2mSlope: number;
  t2mP: number;
  shiftYear?: string;
  updatedAt: string;
}): ETGResearchDossier {
  const { precipSlope, precipP, rhSlope, rhP, t2mSlope, t2mP, shiftYear, updatedAt } = params;
  return {
    abstract: `Subtropical Central Chile and the adjacent Southern Andes (-33.5°S, -70.7°W) exhibit persistent precipitation deficit (${precipSlope.toFixed(4)} mm/d/yr, p=${precipP.toFixed(4)}), relative humidity decline (${rhSlope.toFixed(3)} %/yr, p=${rhP.toFixed(4)}), and surface warming (+${t2mSlope.toFixed(4)} °C/yr, p=${t2mP.toFixed(4)})${shiftYear ? ` with structural regime shift around ${shiftYear}` : ""}.`,
    physical_mechanism:
      "Poleward expansion of the Southeast Pacific Subtropical Anticyclone coupled with a positive Southern Annular Mode (SAM) and central-equatorial Pacific SST cooling anomalies deflects mid-latitude frontal storm tracks southward away from 30°S–38°S, starving Andean snowpack and valley aquifers.",
    empirical_findings: [
      `[signal-bench-chile-precip] NASA POWER PRECTOTCORR slope: ${precipSlope.toFixed(4)} mm/d/yr (MK p=${precipP.toFixed(4)}).`,
      `[signal-bench-chile-rh2m] NASA POWER RH2M drying slope: ${rhSlope.toFixed(3)} %/yr (MK p=${rhP.toFixed(4)}).`,
      `[signal-bench-chile-t2m] NASA POWER T2M slope: +${t2mSlope.toFixed(4)} °C/yr (MK p=${t2mP.toFixed(4)})${shiftYear ? `; Pettitt shift ${shiftYear}` : ""}.`,
    ],
    impacts: [
      "Uninterrupted multi-year snowpack deficit in the Maipo and Aconcagua Andean catchments.",
      "Hydrological depletion in central Chilean reservoirs and heightened austral-summer wildfire susceptibility.",
    ],
    citations: [VERIFIED_CITATIONS.garreaud2020Chile, VERIFIED_CITATIONS.ipccAr6Wg1],
    markdown_body: `### Why Climate Attribution Replaced Raw Volcano Metadata

Previously, raw volcanic event proximity caused automated clustering to label this latitude band after a nearby volcano. Re-anchoring the trend to MERRA-2 precipitation, 2 m humidity, and temperature isolates the well-documented **Central Chile Megadrought** analyzed by Garreaud et al. (2020), driven by large-scale subtropical subsidence and Southern Annular Mode trends rather than geological volcanism.`,
    updated_at: updatedAt,
    researched_by: "agency_curation",
  };
}

export function buildSwNorthAmericaMegadroughtDossier(params: {
  t2mSlope: number;
  t2mP: number;
  rhSlope: number;
  rhP: number;
  precipSlope: number;
  precipP: number;
  updatedAt: string;
}): ETGResearchDossier {
  const { t2mSlope, t2mP, rhSlope, rhP, precipSlope, precipP, updatedAt } = params;
  return {
    abstract: `Across the Colorado Plateau and Southwestern North America (36.8°N, -112.1°W), compounding warming (+${t2mSlope.toFixed(4)} °C/yr, p=${t2mP.toFixed(4)}) and boundary-layer drying (${rhSlope.toFixed(3)} %RH/yr, p=${rhP.toFixed(4)}) amplify atmospheric Vapor Pressure Deficit (VPD) even where precipitation trends (${precipSlope.toFixed(4)} mm/d/yr, p=${precipP.toFixed(4)}) show multi-decadal variability.`,
    physical_mechanism:
      "Clausius-Clapeyron exponential growth in saturation vapor pressure outpaces boundary-layer moisture supply over semi-arid terrain, driving VPD up sharply, accelerating soil moisture depletion, and increasing fine-fuel flammability across montane conifer belts.",
    empirical_findings: [
      `[signal-bench-swus-t2m] NASA POWER T2M warming slope: +${t2mSlope.toFixed(4)} °C/yr (MK p=${t2mP.toFixed(4)}).`,
      `[signal-bench-swus-rh2m] NASA POWER RH2M trend: ${rhSlope.toFixed(3)} %/yr (MK p=${rhP.toFixed(4)}).`,
      `[signal-bench-swus-precip] NASA POWER PRECTOTCORR trend: ${precipSlope.toFixed(4)} mm/d/yr (MK p=${precipP.toFixed(4)}).`,
    ],
    impacts: [
      "Colorado River Basin Lake Powell/Mead storage stress via warming-driven runoff inefficiency (~9%/°C decline).",
      "Extended western wildfire seasons and elevated post-fire watershed sediment/debris hazards.",
    ],
    citations: [VERIFIED_CITATIONS.williams2022Megadrought, VERIFIED_CITATIONS.jain2022FireWeather],
    markdown_body: `### Temperature-Humidity Synergy in Megadrought Severity

Williams et al. (2022) showed that 2000–2021 constitutes Southwestern North America's driest 22-year period since 800 CE, with ~42% of severity attributable to human-driven warming raising evaporative demand. Paired MERRA-2 \`T2M\` and \`RH2M\` nodes inside the ETG capture this local Clausius-Clapeyron \`amplifies\` coupling directly rather than misclassifying co-located drying as a remote teleconnection.`,
    updated_at: updatedAt,
    researched_by: "agency_curation",
  };
}

export function buildIndoPacificHornDipoleDossier(params: {
  hornT2mSlope: number;
  hornRhSlope: number;
  hornRhP: number;
  indoT2mSlope: number;
  indoPrecipSlope: number;
  detrendedR: number;
  updatedAt: string;
}): ETGResearchDossier {
  const {
    hornT2mSlope,
    hornRhSlope,
    hornRhP,
    indoT2mSlope,
    indoPrecipSlope,
    detrendedR,
    updatedAt,
  } = params;
  return {
    abstract: `Across the Indian Ocean basin, western-Indian / Greater Horn of Africa warming and humidity stress (+${hornT2mSlope.toFixed(4)} °C/yr; RH ${hornRhSlope.toFixed(3)} %/yr, p=${hornRhP.toFixed(4)}) dynamically interact with Indo-Pacific Warm Pool convection (T2M +${indoT2mSlope.toFixed(4)} °C/yr; precip ${indoPrecipSlope.toFixed(4)} mm/d/yr; detrended cross-basin r*=${detrendedR.toFixed(2)}).`,
    physical_mechanism:
      "Zonal sea-surface temperature gradients across the tropical Indian Ocean (Indian Ocean Dipole) and Walker Circulation overturning redistribute deep atmospheric convection between the Maritime Continent / Indonesia ascending branch and East Africa / Madagascar subsidence zones.",
    empirical_findings: [
      `[signal-bench-hornafrica-t2m] and [signal-bench-hornafrica-rh2m] capture East African thermal-aridity stress (RH2M p=${hornRhP.toFixed(4)}).`,
      `[signal-bench-indopac-t2m] and [signal-bench-indopac-precip] track Maritime Continent thermal/convective state across ~8,900 km of ocean.`,
      `Cross-basin detrended correlation r*=${detrendedR.toFixed(2)} isolates interannual zonal dipole oscillation independent of global background warming.`,
    ],
    impacts: [
      "Multi-season East African 'Long Rains' failure when Indian Ocean SST gradients shift easterly onshore moisture convergence.",
      "Compound agricultural & pastoral water stress across Kenya, Somalia, Ethiopia, and southern Madagascar.",
    ],
    citations: [VERIFIED_CITATIONS.saji1999Iod, VERIFIED_CITATIONS.funk2008EastAfrica],
    markdown_body: `### True Interannual Dipole vs. Co-Located Pixel Arithmetic

By pairing observations separated by ~8,900 km across the ascending and descending branches of the tropical Indo-Pacific circulation—and screening via detrended interannual correlation—ETG distinguishes genuine ocean-atmosphere teleconnections from trivial same-grid humidity arithmetic.`,
    updated_at: updatedAt,
    researched_by: "agency_curation",
  };
}

export function buildNorthAtlanticDivergenceDossier(params: {
  subpolarSlope: number;
  subpolarP: number;
  arcticSlope: number;
  hamburgOrBorealNote: string;
  detrendedOrRawR: number;
  updatedAt: string;
}): ETGResearchDossier {
  const { subpolarSlope, subpolarP, arcticSlope, hamburgOrBorealNote, detrendedOrRawR, updatedAt } =
    params;
  return {
    abstract: `The Subpolar North Atlantic Gyre (53.5°N, -35.5°W) exhibits muted or negative thermal slope (${subpolarSlope >= 0 ? "+" : ""}${subpolarSlope.toFixed(4)} °C/yr, p=${subpolarP.toFixed(4)})—the 'North Atlantic Warming Hole'—in sharp contrast to rapid Pan-Arctic warming (+${arcticSlope.toFixed(4)} °C/yr) and European station warming (${hamburgOrBorealNote}).`,
    physical_mechanism:
      "Weakening of the Atlantic Meridional Overturning Circulation (AMOC) slows northward oceanic heat transport into the subpolar gyre south of Greenland while subpolar freshwater input from Greenland meltwater and Arctic export stratifies the upper ocean.",
    empirical_findings: [
      `[signal-bench-subpolar-natl-t2m] records ${subpolarSlope >= 0 ? "+" : ""}${subpolarSlope.toFixed(4)} °C/yr (MK p=${subpolarP.toFixed(4)}) south of Greenland/Iceland.`,
      `Coupling vs. Pan-Arctic warming [signal-gistemp-64n-90n] yields cross-band r=${detrendedOrRawR.toFixed(2)} against KNMI NAO/AMO variability.`,
      "Corroborated with KNMI North Atlantic Oscillation / Atlantic Multidecadal Oscillation indices and European NOAA NCEI station data.",
    ],
    impacts: [
      "Modulation of North Atlantic storm-track position and summer European jet-stream persistence.",
      "Dynamic coastal sea-level steric anomalies along the US Northeast seaboard.",
    ],
    citations: [VERIFIED_CITATIONS.caesar2018Amoc, VERIFIED_CITATIONS.ipccAr6Wg1],
    markdown_body: `### Spatial Fingerprint of AMOC Slowdown

Caesar et al. (2018) identified the subpolar North Atlantic 'warming hole'—a localized region of suppressed warming or cooling amid global ocean warming—as a primary diagnostic fingerprint of AMOC weakening. Including [signal-bench-subpolar-natl-t2m] anchors this oceanic dynamical regime inside ETG alongside KNMI atmospheric/ocean indices.`,
    updated_at: updatedAt,
    researched_by: "agency_curation",
  };
}

export function buildArcticHydrologyDossier(params: {
  regionName: string;
  arcticTempSlope: number;
  hydroDescription: string;
  updatedAt: string;
}): ETGResearchDossier {
  const { regionName, arcticTempSlope, hydroDescription, updatedAt } = params;
  return {
    abstract: `Pan-Arctic hydrological gauges and satellite altimetry across ${regionName} reflect accelerating cold-season baseflow and snowmelt timing shifts coupled to +${arcticTempSlope.toFixed(4)} °C/yr regional warming.`,
    physical_mechanism:
      "Permafrost active-layer deepening enhances subsurface hydraulic conductivity and winter groundwater discharge into major Arctic basins (Mackenzie, Yukon, Lena, Yenisei), while warmer spring air temperatures advance freshet onset.",
    empirical_findings: [
      `${hydroDescription}`,
      "Corroborated across CSA Geo.ca WSC hydrometric monitoring and NASA SWOT RiverSP orbital water-surface elevation passes.",
      "Linked downstream to Beaufort/Arctic Ocean freshwater stratification and sea-ice thermodynamics.",
    ],
    impacts: [
      "Altered spring ice-jam flood timing and sediment/DOC export into the Arctic Ocean coastal shelf.",
      "Freshwater halocline stabilization affecting Arctic Ocean vertical heat mixing.",
    ],
    citations: [VERIFIED_CITATIONS.feng2021ArcticRivers, VERIFIED_CITATIONS.rantanen2022Arctic],
    updated_at: updatedAt,
    researched_by: "agency_curation",
  };
}

export function buildRegionalClimateDossier(params: {
  regionName: string;
  eventTitle?: string;
  eventCategory?: string;
  t2m?: { slope: number; p: number; adjP: number; shiftYear?: string };
  precip?: { slope: number; p: number; adjP: number };
  rh2m?: { slope: number; p: number; adjP: number };
  tRhCorrelation?: number;
  updatedAt: string;
}): ETGResearchDossier {
  const { regionName, eventTitle, eventCategory, t2m, precip, rh2m, tRhCorrelation, updatedAt } =
    params;

  const isFireWeather =
    eventCategory === "wildfires" ||
    Boolean(rh2m && rh2m.slope < 0 && t2m && t2m.slope > 0);
  const findings: string[] = [];

  if (t2m) {
    findings.push(
      `Surface air temperature (NASA POWER T2M): ${t2m.slope >= 0 ? "+" : ""}${t2m.slope.toFixed(4)} °C/yr (MK p=${t2m.p.toFixed(4)}, Hamed-Rao adj p=${t2m.adjP.toFixed(4)})${t2m.shiftYear ? `, regime shift near ${t2m.shiftYear}` : ""}.`
    );
  }
  if (rh2m) {
    findings.push(
      `Boundary-layer relative humidity (NASA POWER RH2M): ${rh2m.slope >= 0 ? "+" : ""}${rh2m.slope.toFixed(3)} %/yr (MK p=${rh2m.p.toFixed(4)}, Hamed-Rao adj p=${rh2m.adjP.toFixed(4)}).`
    );
  }
  if (precip) {
    findings.push(
      `Precipitation (NASA POWER PRECTOTCORR): ${precip.slope >= 0 ? "+" : ""}${precip.slope.toFixed(4)} mm/d/yr (MK p=${precip.p.toFixed(4)}, Hamed-Rao adj p=${precip.adjP.toFixed(4)}).`
    );
  }
  if (typeof tRhCorrelation === "number") {
    findings.push(
      `Co-located T2M vs. RH2M local thermodynamic coupling: Pearson r=${tRhCorrelation.toFixed(2)} (Clausius-Clapeyron VPD sensitivity).`
    );
  }
  if (eventTitle) {
    findings.push(
      `Linked NASA EONET discrete impulse event: "${cleanEonetEventTitle(eventTitle)}" (${eventCategory || "hazard"}) contextualized against 31-year background climatology.`
    );
  }

  return {
    abstract: `31-year NASA POWER MERRA-2 multi-variable synthesis across ${regionName}${eventTitle ? `, evaluated alongside active ${eventCategory || "environmental"} impulse "${cleanEonetEventTitle(eventTitle)}"` : ""}.`,
    physical_mechanism: isFireWeather
      ? "Rising 2 m air temperature increases saturation vapor pressure exponentially (~7%/°C), lowering relative humidity and elevating Vapor Pressure Deficit (VPD). This desiccates dead and live vegetation fuels, preconditioning the landscape for extreme fire-weather days."
      : "Sustained multi-decadal boundary-layer thermal and moisture trends shift background hydro-climatic return periods, altering soil water balance and convective or synoptic extreme risk.",
    empirical_findings: findings,
    impacts: isFireWeather
      ? [
          "Increased frequency of critical fire-weather thresholds and dry lightning / fuel-aridity overlap.",
          "Elevated regional smoke-particulate (PM2.5) episodes downwind.",
        ]
      : [
          "Shifting seasonal hydrological baselines affecting catchment runoff and ecological moisture stress.",
        ],
    citations: isFireWeather
      ? [VERIFIED_CITATIONS.jain2022FireWeather, VERIFIED_CITATIONS.ipccAr6Wg1]
      : [VERIFIED_CITATIONS.ipccAr6Wg1],
    updated_at: updatedAt,
    researched_by: "agency_curation",
  };
}
