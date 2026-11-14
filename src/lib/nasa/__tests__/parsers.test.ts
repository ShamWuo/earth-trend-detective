import { describe, expect, it } from "vitest";
import { extractGeometryCentroid } from "@/lib/nasa/eonetClient";
import {
  parseGistempZonalCsv,
  parseNoaaCo2AnnMean,
  parseNsidcSeaIceCsv,
} from "@/lib/nasa/gistempAndCo2Client";
import { parseNasaPowerMonthlyPayload } from "@/lib/nasa/nasaPowerClient";
import {
  parseGeocaAhccdJson,
  parseGeocaHydrometricJson,
  parseKnmiIndexDat,
  parseNoaaCdoGsoyJson,
  parseUsgsAnnualRdb,
} from "@/lib/agencies/challengeSourcesClient";
import { parseAgencyFormattedText } from "@/lib/discovery/datasetImport";

describe("NASA & NOAA live dataset parsers", () => {
  it("parses NASA GISTEMP v4 zonal CSV rows and skips missing sentinels", () => {
    const csv = [
      "Year,Glob,NHem,SHem,24N-90N,24S-24N,90S-24S,64N-90N,44N-64N,24N-44N,EQU-24N,24S-EQU,44S-24S,64S-44S,90S-64S",
      "1994,0.31,0.36,0.26,0.50,0.25,0.18,0.61,0.48,0.35,0.21,0.28,0.20,0.12,***",
      "2020,1.01,1.35,0.67,1.65,0.92,0.45,2.10,1.50,1.25,0.95,0.88,0.52,0.22,0.30",
      "2021,0.85,1.14,0.56,1.40,0.75,0.38,1.90,1.32,1.10,0.78,0.72,0.45,0.18,0.25",
      "2022,0.89,1.18,0.60,1.48,0.80,0.41,2.05,1.40,1.18,0.84,0.76,0.48,0.21,0.29",
      "2023,1.17,1.49,0.85,1.81,1.02,0.51,2.45,1.72,1.41,1.05,0.98,0.62,0.28,0.39",
      "2024,1.28,1.62,0.94,1.95,1.18,0.55,2.60,1.86,1.53,1.22,1.13,0.70,0.25,0.44",
    ].join("\n");

    const parsed = parseGistempZonalCsv(csv, 1995, 2025);
    expect(parsed.globalSeries.length).toBe(5);
    expect(parsed.globalSeries[0]).toEqual({ date: "2020", t: 2020, value: 1.01 });

    const arctic = parsed.zones.find((z) => z.column === "64N-90N");
    expect(arctic?.points.length).toBe(5);
    expect(arctic?.points[4].value).toBe(2.6);
  });

  it("parses NOAA GML global marine CO2 annual mean text table", () => {
    const txt = [
      "# NOAA GML header comment",
      "year     mean      unc",
      "2022   417.07     0.07",
      "2023   419.31     0.06",
      "2024   422.80     0.07",
      "2025   425.62     0.08",
    ].join("\n");

    const pts = parseNoaaCo2AnnMean(txt, 1995, 2025);
    expect(pts.length).toBe(4);
    expect(pts[0]).toEqual({ date: "2022", t: 2022, value: 417.07 });
    expect(pts[3]).toEqual({ date: "2025", t: 2025, value: 425.62 });
  });

  it("excludes NASA POWER M13 summary keys and -999 fill sentinels", () => {
    const pts = parseNasaPowerMonthlyPayload({
      "202301": 10.2,
      "202302": 10.8,
      "202303": 11.4,
      "202304": 12.0,
      "202305": 13.0,
      "202306": 14.2,
      "202307": -999,
      "202313": 12.1,
    });
    expect(pts.length).toBe(1);
    expect(pts[0].date).toBe("2023");
    expect(pts[0].value).toBeCloseTo(11.933, 2);
  });

  it("resolves both GeoJSON Point and Polygon rings in NASA EONET geometry", () => {
    expect(extractGeometryCentroid([-120.5, 38.9])).toEqual([-120.5, 38.9]);
    expect(
      extractGeometryCentroid([
        [
          [10, 20],
          [14, 20],
          [14, 24],
          [10, 24],
        ],
      ])
    ).toEqual([12, 22]);
  });

  it("parses NOAA/NSIDC Sea Ice Index v4.0 CSV and skips invalid sentinel rows", () => {
    const csv = [
      "year, mo,source_dataset, region, extent,   area",
      "1979,  9,    NSIDC-0051,      N,   7.05,   4.58",
      "2021,  9,    NSIDC-0051,      N,  -9999,  -9999",
      "2022,  9,    NSIDC-0051,      N,   4.90,   3.47",
      "2023,  9,    NSIDC-0051,      N,   4.38,   2.83",
      "2024,  9,    NSIDC-0051,      N,   4.35,   2.91",
      "2025,  9,    NSIDC-0803,      N,   4.75,   3.08",
    ].join("\n");

    const pts = parseNsidcSeaIceCsv(csv, 1995, 2025);
    expect(pts.length).toBe(4);
    expect(pts[0]).toEqual({ date: "2022", t: 2022, value: 4.9 });
    expect(pts[3]).toEqual({ date: "2025", t: 2025, value: 4.75 });
  });

  it("parses NOAA NCEI CDO GSOY JSON rows and filters invalid TAVG sentinels", () => {
    const rows = [
      { STATION: "USW00027502", DATE: "1994", TAVG: "-12.1" },
      { STATION: "USW00027502", DATE: "2019", TAVG: "-9.4" },
      { STATION: "USW00027502", DATE: "2020", TAVG: "-999.9" },
      { STATION: "USW00027502", DATE: "2021", TAVG: null },
      { STATION: "USW00027502", DATE: "2022", TAVG: "-8.9" },
      { STATION: "USW00027502", DATE: "2023", TAVG: "-8.2" },
      { STATION: "USW00027502", DATE: "2024", TAVG: "-7.6" },
      { STATION: "USW00027502", DATE: "2025", TAVG: "-7.1" },
      { STATION: "UNKNOWN_STN", DATE: "2024", TAVG: "14.0" },
    ];

    const records = parseNoaaCdoGsoyJson(rows, 1995, 2025);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("noaa-cdo-usw00027502");
    expect(records[0].provenance).toBe("NOAA NCEI CDO (Live)");
    expect(records[0].points.map((p) => p.date)).toEqual(["2019", "2022", "2023", "2024", "2025"]);
  });

  it("parses KNMI Climate Explorer .dat monthly tables while ignoring -999.9 sentinels", () => {
    const dat = [
      "# KNMI Climate Explorer ERSSTv5 Nino3.4",
      "# YEAR JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC",
      "2023 0.50 0.60 0.70 0.80 0.90 1.00 1.10 1.20 1.30 1.40 -999.9 -999.9",
      "2024 1.50 1.40 1.20 0.90 0.50 0.20 -999.9 -999.9 -999.9 -999.9 -999.9 -999.9",
      "2025 0.10 -999.9 -999.9 -999.9 -999.9 -999.9 -999.9 -999.9 -999.9 -999.9 -999.9 -999.9",
    ].join("\n");

    const pts = parseKnmiIndexDat(dat, 1995, 2025);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ date: "2023", t: 2023, value: 0.95 });
    expect(pts[1]).toEqual({ date: "2024", t: 2024, value: 0.95 });
  });

  it("parses Geo.ca hydrometric discharge and AHCCD climate GeoJSON skipping -9999.9 and null", () => {
    const hydroGeoJson = {
      features: [2019, 2020, 2021, 2022, 2023, 2024].map((yr, idx) => ({
        geometry: { coordinates: [-133.75, 67.46] as [number, number] },
        properties: {
          MAX_DATE: `${yr}-06-05`,
          MAX_VALUE: yr === 2020 ? -9999 : 21000 + idx * 950,
        },
      })),
    };

    const hydroRec = parseGeocaHydrometricJson(
      hydroGeoJson,
      {
        id: "geoca-mackenzie",
        name: "Mackenzie River",
        region: "NWT",
        fallbackLat: 67.0,
        fallbackLng: -133.0,
        sourceUrl: "https://api.weather.gc.ca/collections/hydrometric-annual-statistics/items",
      },
      1995,
      2025
    );
    expect(hydroRec).not.toBeNull();
    expect(hydroRec!.points.map((p) => p.date)).toEqual(["2019", "2021", "2022", "2023", "2024"]);

    const ahccdGeoJson = {
      features: [
        { geometry: { coordinates: [-68.52, 70.49] as [number, number] }, properties: { year__annee: 2019, temp_mean__temp_moyenne: -11.4 } },
        { geometry: { coordinates: [-68.52, 70.49] as [number, number] }, properties: { year__annee: 2020, temp_mean__temp_moyenne: null } },
        { geometry: { coordinates: [-68.52, 70.49] as [number, number] }, properties: { year__annee: 2021, temp_mean__temp_moyenne: -9999.9 } },
        { geometry: { coordinates: [-68.52, 70.49] as [number, number] }, properties: { year__annee: 2022, temp_mean__temp_moyenne: -10.8 } },
        { geometry: { coordinates: [-68.52, 70.49] as [number, number] }, properties: { year__annee: 2023, temp_mean__temp_moyenne: -10.2 } },
        { geometry: { coordinates: [-68.52, 70.49] as [number, number] }, properties: { year__annee: 2024, temp_mean__temp_moyenne: -9.8 } },
        { geometry: { coordinates: [-68.52, 70.49] as [number, number] }, properties: { year__annee: 2025, temp_mean__temp_moyenne: -9.5 } },
      ],
    };

    const ahccdRec = parseGeocaAhccdJson(
      ahccdGeoJson,
      {
        id: "geoca-clyde",
        name: "Clyde River AHCCD",
        region: "Nunavut",
        fallbackLat: 70.0,
        fallbackLng: -68.0,
        sourceUrl: "https://api.weather.gc.ca/collections/ahccd-annual/items",
      },
      1995,
      2025
    );
    expect(ahccdRec).not.toBeNull();
    expect(ahccdRec!.points.map((p) => p.date)).toEqual(["2019", "2022", "2023", "2024", "2025"]);
  });

  it("parses USGS NWIS RDB annual discharge output and converts cfs to m³/s", () => {
    const rdb = [
      "# USGS NWIS Annual Statistics",
      "agency_cd\tsite_no\tyear_nu\tmean_va",
      "5s\t15s\t4s\t12s",
      "USGS\t07374000\t2022\t500000",
      "USGS\t07374000\t2023\t420000",
    ].join("\n");

    const pts = parseUsgsAnnualRdb(rdb, 1995, 2025);
    expect(pts).toHaveLength(2);
    expect(pts[0].date).toBe("2022");
    expect(pts[0].value).toBeCloseTo(500000 * 0.0283168466, 0);
  });

  it("parses NASA Giovanni CSV preambles with Bounding Box and GES DISC Data Rods BEGIN DATA ASCII", () => {
    const giovanniCsv = [
      "Title: Area-Averaged SeaWiFS Chlorophyll-a Concentration",
      "Bounding Box: [-92.0, 27.0, -88.0, 29.0]",
      "time,chlor_a",
      "2020-01,1.42",
      "2021-01,1.65",
    ].join("\n");

    const gRows = parseAgencyFormattedText(giovanniCsv);
    expect(gRows).toHaveLength(2);
    expect(gRows[0].lat).toBe(28);
    expect(gRows[0].lng).toBe(-90);
    expect(gRows[0].date).toBe("2020-01");
    expect(Number(gRows[0].value)).toBeCloseTo(1.42, 4);

    const dataRodsTxt = [
      "Parameter: Root Zone Soil Moisture",
      "Latitude: 36.75",
      "Longitude: -119.80",
      "BEGIN DATA",
      "2022-06-01T00Z 412.5",
      "2023-06-01T00Z -9999.0",
      "2024-06-01T00Z 388.2",
      "END DATA",
    ].join("\n");

    const dRows = parseAgencyFormattedText(dataRodsTxt);
    expect(dRows).toHaveLength(2);
    expect(dRows[0].lat).toBe(36.75);
    expect(dRows[0].lng).toBe(-119.8);
    expect(dRows[0].name).toBe("Root Zone Soil Moisture");
    expect(dRows[1].value).toBe(388.2);
  });
});
