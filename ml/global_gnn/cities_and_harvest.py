"""
36-City Global Multi-Variable Spatiotemporal Harvester (`252` stations, `2019-2026`).

Splits:
  - `global_train` (30 cities, 210 stations): Trained strictly on dates < 2025-01-01
    (`2019-2023` train, `2024` validation).
  - `global_test` (5 cross-continent cities, 35 stations): Held out 100% spatially
    and evaluated strictly on unseen `2025-2026` dates.
  - `denver_showcase` (1 city, 7 exact `DENVER_CLIMATE_NODES`): Held out 100% from
    global pretraining and evaluated on unseen `2025-2026` (`n >= 606` days) both
    Zero-Shot and with a 2019-2023 local residual adapter.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import time
from typing import Any, Dict, List, Optional, Sequence, Tuple, Union
import urllib.error
import urllib.request


EARTH_RADIUS_KM = 6371.0
RING_RADIUS_KM = 115.0
RING_DIRECTIONS: List[Tuple[str, float]] = [
    ("W", 270.0),
    ("NNW", 330.0),
    ("NNE", 30.0),
    ("E", 90.0),
    ("SSE", 150.0),
    ("SSW", 210.0),
]

DENVER_EXACT_NODES: List[Dict[str, Any]] = [
    {"id": "denver-target", "name": "Denver (Target Microgrid)", "role": "target", "direction": "CENTER", "distance_km": 0.0, "lat": 39.74, "lng": -104.99, "elevation_m": 1609.0},
    {"id": "silverthorne-w", "name": "Silverthorne / Continental Divide", "role": "upwind_neighbor", "direction": "W", "distance_km": 93.0, "lat": 39.63, "lng": -106.07, "elevation_m": 2754.0},
    {"id": "fort-collins-nnw", "name": "Fort Collins", "role": "upwind_neighbor", "direction": "NNW", "distance_km": 95.0, "lat": 40.59, "lng": -105.08, "elevation_m": 1525.0},
    {"id": "cheyenne-n", "name": "Cheyenne, WY", "role": "upwind_neighbor", "direction": "N", "distance_km": 156.0, "lat": 41.14, "lng": -104.82, "elevation_m": 1848.0},
    {"id": "greeley-ne", "name": "Greeley / Brush Plains", "role": "upwind_neighbor", "direction": "NE", "distance_km": 98.0, "lat": 40.25, "lng": -104.05, "elevation_m": 1419.0},
    {"id": "limon-e", "name": "Limon / Eastern Plains", "role": "upwind_neighbor", "direction": "E", "distance_km": 123.0, "lat": 39.26, "lng": -103.69, "elevation_m": 1635.0},
    {"id": "colorado-springs-s", "name": "Colorado Springs", "role": "upwind_neighbor", "direction": "S", "distance_km": 102.0, "lat": 38.83, "lng": -104.82, "elevation_m": 1839.0},
]


@dataclass(frozen=True)
class CitySpec:
    city_id: str
    name: str
    lat: float
    lng: float
    split: str  # "global_train" | "global_test" | "denver_showcase"
    regime: str


GLOBAL_36_CITIES: List[CitySpec] = [
    # --- 30 Global Training Cities (6 continents, diverse Koppen regimes) ---
    CitySpec("phoenix", "Phoenix, AZ", 33.45, -112.07, "global_train", "arid_sw"),
    CitySpec("seattle", "Seattle, WA", 47.61, -122.33, "global_train", "maritime_nw"),
    CitySpec("minneapolis", "Minneapolis, MN", 44.98, -93.27, "global_train", "continental_plains"),
    CitySpec("atlanta", "Atlanta, GA", 33.75, -84.39, "global_train", "humid_subtropical"),
    CitySpec("albuquerque", "Albuquerque, NM", 35.08, -106.65, "global_train", "high_steppe"),
    CitySpec("boise", "Boise, ID", 43.62, -116.20, "global_train", "intermountain_basin"),
    CitySpec("fairbanks", "Fairbanks, AK", 64.84, -147.72, "global_train", "subarctic_boreal"),
    CitySpec("calgary", "Calgary, AB", 51.05, -114.07, "global_train", "chinook_foothills"),
    CitySpec("toronto", "Toronto, ON", 43.65, -79.38, "global_train", "great_lakes"),
    CitySpec("mexico_city", "Mexico City, MX", 19.43, -99.13, "global_train", "tropical_highland"),
    CitySpec("lima", "Lima, PE", -12.05, -77.04, "global_train", "coastal_inversion"),
    CitySpec("bogota", "Bogota, CO", 4.71, -74.07, "global_train", "equatorial_andean"),
    CitySpec("sao_paulo", "Sao Paulo, BR", -23.55, -46.63, "global_train", "subtropical_monsoon"),
    CitySpec("mendoza", "Mendoza, AR", -32.89, -68.84, "global_train", "andean_leeward"),
    CitySpec("london", "London, UK", 51.51, -0.13, "global_train", "maritime_temperate"),
    CitySpec("zurich", "Zurich, CH", 47.37, 8.54, "global_train", "alpine_foreland"),
    CitySpec("munich", "Munich, DE", 48.14, 11.58, "global_train", "alpine_foehn"),
    CitySpec("warsaw", "Warsaw, PL", 52.23, 21.01, "global_train", "european_plains"),
    CitySpec("athens", "Athens, GR", 37.98, 23.73, "global_train", "mediterranean"),
    CitySpec("reykjavik", "Reykjavik, IS", 64.15, -21.94, "global_train", "subpolar_oceanic"),
    CitySpec("cairo", "Cairo, EG", 30.04, 31.24, "global_train", "hyper_arid"),
    CitySpec("nairobi", "Nairobi, KE", -1.29, 36.82, "global_train", "tropical_plateau"),
    CitySpec("johannesburg", "Johannesburg, ZA", -26.20, 28.05, "global_train", "highveld"),
    CitySpec("casablanca", "Casablanca, MA", 33.57, -7.59, "global_train", "atlantic_semi_arid"),
    CitySpec("riyadh", "Riyadh, SA", 24.71, 46.68, "global_train", "desert_plateau"),
    CitySpec("mumbai", "Mumbai, IN", 19.08, 72.88, "global_train", "tropical_monsoon"),
    CitySpec("jaipur", "Jaipur, IN", 26.91, 75.79, "global_train", "semi_arid_monsoon"),
    CitySpec("bangkok", "Bangkok, TH", 13.76, 100.50, "global_train", "tropical_wet_dry"),
    CitySpec("seoul", "Seoul, KR", 37.57, 126.98, "global_train", "east_asian_monsoon"),
    CitySpec("alice_springs", "Alice Springs, AU", -23.70, 133.88, "global_train", "arid_interior"),
    # --- 5 Held-Out Cross-Continent Benchmark Cities ---
    CitySpec("salt_lake_city", "Salt Lake City, UT", 40.76, -111.89, "global_test", "intermountain_analog"),
    CitySpec("madrid", "Madrid, ES", 40.42, -3.70, "global_test", "iberian_plateau"),
    CitySpec("tokyo", "Tokyo, JP", 35.68, 139.65, "global_test", "pacific_monsoon"),
    CitySpec("sydney", "Sydney, AU", -33.87, 151.21, "global_test", "sh_coastal"),
    CitySpec("santiago", "Santiago, CL", -33.45, -70.67, "global_test", "andean_basin"),
    # --- 1 Primary Zero-Shot + Adapted Showcase ---
    CitySpec("denver", "Denver, CO", 39.74, -104.99, "denver_showcase", "front_range_leeward"),
]


def _offset_lat_lng(lat_deg: float, lng_deg: float, bearing_deg: float, dist_km: float) -> Tuple[float, float]:
    lat1 = math.radians(lat_deg)
    lng1 = math.radians(lng_deg)
    brg = math.radians(bearing_deg)
    ang = dist_km / EARTH_RADIUS_KM
    lat2 = math.asin(math.sin(lat1) * math.cos(ang) + math.cos(lat1) * math.sin(ang) * math.cos(brg))
    lng2 = lng1 + math.atan2(
        math.sin(brg) * math.sin(ang) * math.cos(lat1),
        math.cos(ang) - math.sin(lat1) * math.sin(lat2),
    )
    lng2_deg = ((math.degrees(lng2) + 540.0) % 360.0) - 180.0
    return round(math.degrees(lat2), 4), round(lng2_deg, 4)


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2.0) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2.0) ** 2
    return EARTH_RADIUS_KM * 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))


def build_city_ring_nodes(city: CitySpec) -> List[Dict[str, Any]]:
    """Return the exact 7-node subgraph for a city (index 0 is always target center)."""
    if city.city_id == "denver":
        return [dict(n) for n in DENVER_EXACT_NODES]
    nodes: List[Dict[str, Any]] = [
        {
            "id": f"{city.city_id}-target",
            "name": f"{city.name} (Target)",
            "role": "target",
            "direction": "CENTER",
            "distance_km": 0.0,
            "lat": round(city.lat, 4),
            "lng": round(city.lng, 4),
            "elevation_m": 0.0,
        }
    ]
    for dir_lbl, brg in RING_DIRECTIONS:
        n_lat, n_lng = _offset_lat_lng(city.lat, city.lng, brg, RING_RADIUS_KM)
        nodes.append(
            {
                "id": f"{city.city_id}-{dir_lbl.lower()}",
                "name": f"{city.name} ({dir_lbl})",
                "role": "upwind_neighbor",
                "direction": dir_lbl,
                "distance_km": round(_haversine_km(city.lat, city.lng, n_lat, n_lng), 1),
                "lat": n_lat,
                "lng": n_lng,
                "elevation_m": 0.0,
            }
        )
    return nodes


def estimate_astronomical_clrsky_kwh(lat_deg: float, elev_m: float, doy: int) -> float:
    """Duffie-Beckman daily TOA irradiance + altitude atmospheric transmittance."""
    phi = math.radians(lat_deg)
    delta = math.radians(23.45 * math.sin(math.radians(360.0 * (284 + doy) / 365.0)))
    cos_ws = max(-1.0, min(1.0, -math.tan(phi) * math.tan(delta)))
    ws = math.acos(cos_ws)
    dr = 1.0 + 0.033 * math.cos(2.0 * math.pi * doy / 365.0)
    toa_kwh = (24.0 / math.pi) * 1.367 * dr * (
        math.cos(phi) * math.cos(delta) * math.sin(ws) + ws * math.sin(phi) * math.sin(delta)
    )
    trans = 0.745 + 2.4e-5 * max(0.0, min(4200.0, elev_m))
    return max(0.4, toa_kwh * trans)


def _fetch_json_with_retry(url: str, timeout: float = 90.0, retries: int = 5) -> Any:
    last_err: Optional[Exception] = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "Accept": "application/json",
                    "User-Agent": "EarthTrendDetective/3.0 (Global-GNN-Harvester)",
                },
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            last_err = err
            if err.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                wait = min(30.0, 2.0 * (2 ** attempt))
                time.sleep(wait)
                continue
            raise
        except Exception as err:
            last_err = err
            if attempt < retries - 1:
                time.sleep(min(20.0, 1.8 * (2 ** attempt)))
                continue
            raise
    if last_err is not None:
        raise last_err
    raise RuntimeError("Unexpected retry exit")


def _chunk_year_ranges(
    start_date: str,
    end_date: str,
    max_years: int = 4,
) -> List[Tuple[str, str]]:
    """Split an ISO date range into <= max_years windows formatted as (YYYYMMDD, YYYYMMDD)."""
    start_dt = datetime.strptime(start_date[:10], "%Y-%m-%d").date()
    end_dt = datetime.strptime(end_date[:10], "%Y-%m-%d").date()
    windows: List[Tuple[str, str]] = []
    cur_start = start_dt
    while cur_start <= end_dt:
        cur_end_year = min(end_dt.year, cur_start.year + max_years - 1)
        cur_end = end_dt if cur_end_year == end_dt.year else datetime(cur_end_year, 12, 31).date()
        windows.append((cur_start.strftime("%Y%m%d"), cur_end.strftime("%Y%m%d")))
        cur_start = cur_end + timedelta(days=1)
    return windows


def _tetens_vpd(t2m_c: float, rh_pct: float) -> float:
    es = 0.61078 * math.exp((17.27 * t2m_c) / max(10.0, t2m_c + 237.3))
    return max(0.0, es * max(0.0, 1.0 - rh_pct / 100.0))


def _fetch_nasa_with_end_fallback(
    url_builder: Any,
    end_yyyymmdd: str,
    timeout: float = 90.0,
) -> Any:
    try:
        return _fetch_json_with_retry(url_builder(end_yyyymmdd), timeout=timeout, retries=5)
    except urllib.error.HTTPError as err:
        if err.code in (400, 422):
            end_dt = datetime.strptime(end_yyyymmdd, "%Y%m%d").date() - timedelta(days=7)
            return _fetch_json_with_retry(
                url_builder(end_dt.strftime("%Y%m%d")), timeout=timeout, retries=4
            )
        raise


def _fetch_nasa_power_full_station(
    node_meta: Dict[str, Any],
    start_date: str,
    end_date: str,
    cache_root: Path,
) -> Tuple[float, Dict[str, Dict[str, float]]]:
    """
    Fetch official NASA POWER Daily + Hourly (Local Solar Time `LST`) for one station.
    `PS` is in kPa so evening pressure tendency `eve_ps_trend` is scaled by * 10.0 to hPa.
    """
    start_yyyymmdd = start_date[:10].replace("-", "")
    end_yyyymmdd = end_date[:10].replace("-", "")
    cache_file = cache_root / f"nasa_station_{node_meta['id']}_{start_yyyymmdd}_{end_yyyymmdd}.json"
    if cache_file.exists():
        cached = json.loads(cache_file.read_text(encoding="utf-8"))
        return float(cached["elevation_m"]), cached["rows"]

    lat = float(node_meta["lat"])
    lng = float(node_meta["lng"])

    daily_params = "ALLSKY_SFC_SW_DWN,CLRSKY_SFC_SW_DWN,CLOUD_AMT,T2M,RH2M,PRECTOTCORR,WS10M,WD10M,PS,GWETROOT"
    daily_json = _fetch_nasa_with_end_fallback(
        lambda e_ymd: (
            "https://power.larc.nasa.gov/api/temporal/daily/point"
            f"?parameters={daily_params}&community=RE&longitude={lng}&latitude={lat}"
            f"&start={start_yyyymmdd}&end={e_ymd}&format=JSON"
        ),
        end_yyyymmdd,
        timeout=90.0,
    )

    elev_m = float(node_meta.get("elevation_m") or 0.0)
    if elev_m <= 0.0:
        coords = daily_json.get("geometry", {}).get("coordinates") or []
        if len(coords) >= 3:
            try:
                geom_elev = float(coords[2])
                if geom_elev > -900.0:
                    elev_m = max(0.0, geom_elev)
            except (TypeError, ValueError):
                pass

    dp = daily_json.get("properties", {}).get("parameter", {})
    allsky_map = dp.get("ALLSKY_SFC_SW_DWN") or {}
    clrsky_map = dp.get("CLRSKY_SFC_SW_DWN") or {}
    cloud_map = dp.get("CLOUD_AMT") or {}
    t2m_map = dp.get("T2M") or {}
    rh_map = dp.get("RH2M") or {}
    pre_map = dp.get("PRECTOTCORR") or {}
    ws_map = dp.get("WS10M") or {}
    wd_map = dp.get("WD10M") or {}
    ps_map = dp.get("PS") or {}
    soil_map = dp.get("GWETROOT") or {}

    # NASA POWER Hourly API allows <= 4 years per request; keys are "YYYYMMDDHH" in Local Solar Time (LST)
    evening_buckets: Dict[str, Dict[str, Any]] = {}
    hourly_params = "CLOUD_AMT,RH2M,WS10M,WD10M,PS"
    for w_start, w_end in _chunk_year_ranges(start_date, end_date, max_years=4):
        hr_json = _fetch_nasa_with_end_fallback(
            lambda e_ymd, ws_ymd=w_start: (
                "https://power.larc.nasa.gov/api/temporal/hourly/point"
                f"?parameters={hourly_params}&community=RE&longitude={lng}&latitude={lat}"
                f"&start={ws_ymd}&end={e_ymd}&format=JSON"
            ),
            w_end,
            timeout=90.0,
        )
        hp = hr_json.get("properties", {}).get("parameter", {})
        h_cloud = hp.get("CLOUD_AMT") or {}
        h_rh = hp.get("RH2M") or {}
        h_ws = hp.get("WS10M") or {}
        h_wd = hp.get("WD10M") or {}
        h_ps = hp.get("PS") or {}

        for hr_key, cl_raw in h_cloud.items():
            if len(hr_key) != 10:
                continue
            hh = hr_key[8:10]
            if hh not in ("18", "19", "20", "21", "22", "23"):
                continue
            iso_d = f"{hr_key[:4]}-{hr_key[4:6]}-{hr_key[6:8]}"
            b = evening_buckets.setdefault(
                iso_d,
                {
                    "eve_cloud": [],
                    "eve_rh": [],
                    "eve_ws": [],
                    "cloud23": None,
                    "wd23": None,
                    "ps18": None,
                    "ps23": None,
                },
            )
            cl_v = float(cl_raw)
            if cl_v > -900.0:
                b["eve_cloud"].append(cl_v)
                if hh == "23":
                    b["cloud23"] = cl_v
            rh_v = float(h_rh.get(hr_key, -999.0))
            if rh_v > -900.0:
                b["eve_rh"].append(rh_v)
            ws_v = float(h_ws.get(hr_key, -999.0))
            if ws_v > -900.0:
                b["eve_ws"].append(max(0.0, ws_v))
            wd_v = float(h_wd.get(hr_key, -999.0))
            if hh == "23" and wd_v > -900.0:
                b["wd23"] = wd_v % 360.0
            ps_v = float(h_ps.get(hr_key, -999.0))
            if ps_v > -900.0:
                if hh == "18":
                    b["ps18"] = ps_v
                elif hh == "23":
                    b["ps23"] = ps_v

    rows_by_date: Dict[str, Dict[str, float]] = {}
    default_ps = 101.3 * math.exp(-max(0.0, elev_m) / 8434.5)

    for k in sorted(allsky_map.keys()):
        if len(k) != 8:
            continue
        a_raw = float(allsky_map.get(k, -999.0))
        t_raw = float(t2m_map.get(k, -999.0))
        if a_raw <= -900.0 or t_raw <= -900.0:
            continue
        try:
            iso_d = f"{k[:4]}-{k[4:6]}-{k[6:8]}"
            doy = datetime.strptime(iso_d, "%Y-%m-%d").timetuple().tm_yday
        except ValueError:
            continue

        allsky_kwh = max(0.05, a_raw)
        c_raw = float(clrsky_map.get(k, -999.0))
        clrsky_kwh = max(0.4, c_raw) if c_raw > -900.0 else estimate_astronomical_clrsky_kwh(lat, elev_m, doy)
        kt = max(0.02, min(1.08, allsky_kwh / max(clrsky_kwh, 0.5)))

        rh_raw = float(rh_map.get(k, -999.0))
        rh_mean = max(0.0, min(100.0, rh_raw)) if rh_raw > -900.0 else 50.0
        pre_raw = float(pre_map.get(k, -999.0))
        precip_v = max(0.0, pre_raw) if pre_raw > -900.0 else 0.0
        ws_raw = float(ws_map.get(k, -999.0))
        ws_day = max(0.0, ws_raw) if ws_raw > -900.0 else 3.5
        wd_raw = float(wd_map.get(k, -999.0))
        wd_day = (wd_raw % 360.0) if wd_raw > -900.0 else 270.0
        ps_raw = float(ps_map.get(k, -999.0))
        ps_kpa = ps_raw if ps_raw > -900.0 else default_ps
        soil_raw = float(soil_map.get(k, -999.0))
        soil_val = max(0.0, min(1.0, soil_raw)) if soil_raw > -900.0 else 0.22
        cl_day_raw = float(cloud_map.get(k, -999.0))
        daily_cloud = max(0.0, min(100.0, cl_day_raw)) if cl_day_raw > -900.0 else (1.0 - max(0.0, min(1.0, kt))) * 100.0

        b = evening_buckets.get(iso_d, {})
        eve_cloud = sum(b["eve_cloud"]) / len(b["eve_cloud"]) if b.get("eve_cloud") else daily_cloud
        eve_cloud23 = b["cloud23"] if b.get("cloud23") is not None else eve_cloud
        eve_rh = sum(b["eve_rh"]) / len(b["eve_rh"]) if b.get("eve_rh") else rh_mean
        eve_ws = sum(b["eve_ws"]) / len(b["eve_ws"]) if b.get("eve_ws") else ws_day
        eve_wd = b["wd23"] if b.get("wd23") is not None else wd_day
        ps_trend_hpa = (
            (float(b["ps23"]) - float(b["ps18"])) * 10.0
            if b.get("ps23") is not None and b.get("ps18") is not None
            else 0.0
        )

        rows_by_date[iso_d] = {
            "allsky": round(allsky_kwh, 4),
            "clrsky": round(clrsky_kwh, 4),
            "kt": round(kt, 5),
            "t2m": round(t_raw, 3),
            "rh2m": round(rh_mean, 2),
            "vpd": round(_tetens_vpd(t_raw, rh_mean), 4),
            "soil": round(soil_val, 4),
            "precip": round(precip_v, 3),
            "ws10m": round(ws_day, 3),
            "wd10m": round(wd_day % 360.0, 2),
            "ps": round(ps_kpa, 3),
            "eve_cloud": round(eve_cloud, 2),
            "eve_cloud23": round(eve_cloud23, 2),
            "eve_rh": round(eve_rh, 2),
            "eve_ws": round(eve_ws, 3),
            "eve_wd": round(eve_wd % 360.0, 2),
            "eve_ps_trend": round(ps_trend_hpa, 3),
        }

    elev_rounded = round(elev_m, 1)
    cache_file.parent.mkdir(parents=True, exist_ok=True)
    tmp_file = cache_file.with_suffix(".json.tmp")
    tmp_file.write_text(json.dumps({"elevation_m": elev_rounded, "rows": rows_by_date}), encoding="utf-8")
    tmp_file.replace(cache_file)
    return elev_rounded, rows_by_date


def harvest_global_36_city_dataset(
    cache_dir: Union[str, Path] = "/content/etg_global_cache",
    start_date: str = "2019-01-01",
    end_date: str = "2026-11-10",
    cities: Sequence[CitySpec] = GLOBAL_36_CITIES,
    max_workers: int = 10,
) -> Dict[str, Any]:
    """
    Fetch and cache `36 cities x 7 nodes = 252 stations` (`2019-2026`) from
    official NASA POWER Daily + Hourly (`LST`, CERES SYN1deg + MERRA-2).
    """
    cache_root = Path(cache_dir)
    cache_root.mkdir(parents=True, exist_ok=True)
    master_cache = cache_root / f"global_36cities_nasa_{start_date}_{end_date}.json"
    if master_cache.exists():
        return json.loads(master_cache.read_text(encoding="utf-8"))

    city_nodes: Dict[str, List[Dict[str, Any]]] = {
        c.city_id: build_city_ring_nodes(c) for c in cities
    }

    flat_stations: List[Dict[str, Any]] = [
        node for c in cities for node in city_nodes[c.city_id]
    ]
    total_stations = len(flat_stations)
    station_rows: Dict[str, Dict[str, Dict[str, float]]] = {}

    print(
        f"[harvest] Fetching {total_stations} NASA POWER stations ({len(cities)} cities, {start_date}..{end_date}) with {max_workers} workers...",
        flush=True,
    )
    completed = 0
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futs = {
            pool.submit(_fetch_nasa_power_full_station, node, start_date, end_date, cache_root): node
            for node in flat_stations
        }
        for fut in as_completed(futs):
            node = futs[fut]
            elev_m, rows_map = fut.result()
            if node.get("elevation_m", 0.0) <= 0.0:
                node["elevation_m"] = elev_m
            station_rows[node["id"]] = rows_map
            completed += 1
            if completed % 14 == 0 or completed == total_stations:
                print(
                    f"[harvest] Completed {completed}/{total_stations} NASA POWER stations...",
                    flush=True,
                )

    # Assemble per-city aligned day matrices (dates sorted ascending where all 7 nodes exist)
    cities_out: List[Dict[str, Any]] = []
    for c in cities:
        nodes = city_nodes[c.city_id]
        common_dates: Optional[set] = None
        for n in nodes:
            dset = set(station_rows.get(n["id"], {}).keys())
            common_dates = dset if common_dates is None else (common_dates & dset)
        sorted_dates = sorted(common_dates or [])
        cities_out.append(
            {
                "city_id": c.city_id,
                "name": c.name,
                "split": c.split,
                "regime": c.regime,
                "lat": c.lat,
                "lng": c.lng,
                "nodes": nodes,
                "dates": sorted_dates,
                "rows_by_node": {
                    n["id"]: [station_rows[n["id"]][d] for d in sorted_dates]
                    for n in nodes
                },
            }
        )

    bundle = {
        "schema": "etg-global-36city-nasa-v3",
        "start_date": start_date,
        "end_date": end_date,
        "num_cities": len(cities_out),
        "num_stations": sum(len(c["nodes"]) for c in cities_out),
        "cities": cities_out,
    }
    tmp_master = master_cache.with_suffix(".json.tmp")
    tmp_master.write_text(json.dumps(bundle), encoding="utf-8")
    tmp_master.replace(master_cache)
    return bundle
