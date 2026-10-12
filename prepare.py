import argparse
import io
import json
import shutil
from pathlib import Path

import geopandas as gpd
import pandas as pd
import osmnx as ox
import requests
from requests.adapters import HTTPAdapter
from shapely import STRtree
from shapely.ops import unary_union
from urllib3.util.retry import Retry

DATA = Path(__file__).parent / "data"
# Generated for the browser and committed, since the static host can't run this script.
WEB_DATA = Path(__file__).parent / "public" / "data"
TIGER_URL = "https://www2.census.gov/geo/tiger/TIGER2023/CD/tl_2023_34_cd118.zip"
COUSUB_URL = "https://www2.census.gov/geo/tiger/TIGER2023/COUSUB/tl_2023_34_cousub.zip"
NFHL_URL = "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query"
# 2020 census blocks carry POP20 and HOUSING20 directly, so no API key is needed for population.
BLOCKS_URL = "https://www2.census.gov/geo/tiger/TIGER2020/TABBLOCK20/tl_2020_34_tabblock20.zip"
# ACS 2018-2022 table B25044 (tenure by vehicles available), every geography nationwide, keyless bulk file.
ACS_VEHICLES_URL = ("https://www2.census.gov/programs-surveys/acs/summary_file/2022/table-based-SF/"
                    "data/5YRData/acsdt5y2022-b25044.dat")

# Projected CRS for New Jersey (NAD83 / NJ State Plane, meters) so buffers are in real distance.
NJ_CRS = "EPSG:32111"
# Households within this distance of a flood zone, but not in it, are candidates for shadow evacuation.
# NJ-12's floodplains are narrow stream corridors, so even 200 m reaches ~200k people.
SHADOW_RING_M = 200

# FEMA's NFHL server drops connections and 5xxs under load; retry with backoff instead of failing the whole run.
session = requests.Session()
session.mount("https://", HTTPAdapter(max_retries=Retry(total=6, backoff_factor=2, status_forcelist=[500, 502, 503, 504])))


def fetch_district(district: str, out: Path):
    cds = gpd.read_file(TIGER_URL)
    match = cds[cds["CD118FP"] == district]
    if match.empty:
        raise SystemExit(f"no district {district!r} in {TIGER_URL}")
    match[["CD118FP", "geometry"]].to_crs("EPSG:4326").to_file(out, driver="GeoJSON")
    print(f"district NJ-{district}: saved {out}")


def fetch_towns(district_poly, out: Path):
    towns = gpd.read_file(COUSUB_URL).to_crs("EPSG:4326")
    towns = towns[towns.intersects(district_poly)]
    full_area = towns.to_crs(NJ_CRS).area
    clipped = gpd.clip(towns, district_poly)
    # TIGER district and town lines don't coincide exactly; drop the slivers that produces.
    share = clipped.to_crs(NJ_CRS).area / full_area[clipped.index]
    clipped = clipped[share > 0.02]
    clipped[["NAMELSAD", "COUNTYFP", "geometry"]].rename(columns={"NAMELSAD": "name"}).to_file(out, driver="GeoJSON")
    print(f"towns: {len(clipped)} municipalities, saved {out}")


def download(url: str, out: Path):
    with session.get(url, stream=True, timeout=300) as resp:
        resp.raise_for_status()
        with open(out, "wb") as f:
            for chunk in resp.iter_content(1 << 20):
                f.write(chunk)


def fetch_vehicles(out: Path):
    """Households and households with no vehicle, per NJ block group."""
    rows = []
    header = None
    with session.get(ACS_VEHICLES_URL, stream=True, timeout=300) as resp:
        resp.raise_for_status()
        resp.encoding = "utf-8"
        for line in resp.iter_lines(decode_unicode=True):
            if header is None:
                header = line
            elif line.startswith("1500000US34"):  # summary level 150 = block group, state 34 = NJ
                rows.append(line)
    acs = pd.read_csv(io.StringIO("\n".join([header, *rows])), sep="|", dtype={"GEO_ID": str})
    table = pd.DataFrame({
        "bg": acs["GEO_ID"].str[-12:],
        "households": acs["B25044_E001"],
        # Owner- and renter-occupied households with no vehicle available.
        "no_vehicle": acs["B25044_E003"] + acs["B25044_E010"],
    })
    table.to_csv(out, index=False)
    print(f"vehicles: {len(table)} NJ block groups, saved {out}")


def fetch_households(district_poly, flood_path: Path, towns_path: Path, out: Path):
    raw = DATA / "raw"
    raw.mkdir(exist_ok=True)
    blocks_zip = raw / "tl_2020_34_tabblock20.zip"
    if not blocks_zip.exists():
        download(BLOCKS_URL, blocks_zip)
    vehicles_csv = raw / "acs2022_b25044_nj.csv"
    if not vehicles_csv.exists():
        fetch_vehicles(vehicles_csv)

    # Read past the district edge so block groups straddling it are whole when we total their housing units.
    minx, miny, maxx, maxy = district_poly.bounds
    blocks = gpd.read_file(blocks_zip, bbox=(minx - 0.05, miny - 0.05, maxx + 0.05, maxy + 0.05))
    blocks = blocks[blocks["HOUSING20"] > 0].to_crs(NJ_CRS)
    blocks["bg"] = blocks["GEOID20"].str[:12]

    acs = pd.read_csv(vehicles_csv, dtype={"bg": str}).set_index("bg")
    bg_housing = blocks.groupby("bg")["HOUSING20"].sum()
    # ACS counts households per block group; spread them over its blocks by 2020 housing units.
    share = blocks["HOUSING20"] / blocks["bg"].map(bg_housing)
    bg_households = blocks["bg"].map(acs["households"]).fillna(0)
    no_vehicle_rate = (blocks["bg"].map(acs["no_vehicle"]) / bg_households.where(bg_households > 0)).fillna(0)
    blocks["households"] = bg_households * share
    blocks["no_vehicle"] = blocks["households"] * no_vehicle_rate
    blocks["no_vehicle_people"] = blocks["POP20"] * no_vehicle_rate

    district = gpd.GeoSeries([district_poly], crs="EPSG:4326").to_crs(NJ_CRS)[0]
    blocks = blocks[blocks.representative_point().within(district)]
    flood_polys = list(gpd.read_file(flood_path).to_crs(NJ_CRS).geometry)
    flood = unary_union(flood_polys)
    wet = blocks.geometry.intersection(flood)
    frac = (wet.area / blocks.geometry.area).clip(0, 1)
    _, gap = STRtree(flood_polys).query_nearest(blocks.representative_point().values, return_distance=True,
                                                all_matches=False)

    # Within a block, residents are assumed spread evenly, so the flooded share of its area is the flooded share
    # of its people. The dry share of a block near the water is the shadow population.
    counts = ["POP20", "households", "no_vehicle", "no_vehicle_people"]
    flooded = frac > 0.001
    shadow = (gap <= SHADOW_RING_M) & (frac < 0.999)
    parts = []
    for zone, mask, scale, geom in [("flood", flooded, frac, wet), ("shadow", shadow, 1 - frac, blocks.geometry)]:
        part = gpd.GeoDataFrame(blocks.loc[mask, counts].mul(scale[mask], axis=0), geometry=geom[mask], crs=NJ_CRS)
        part.insert(0, "zone", zone)
        part.insert(0, "block", blocks.loc[mask, "GEOID20"])
        parts.append(part)
    areas = pd.concat(parts, ignore_index=True).rename(columns={"POP20": "people"})
    areas["geometry"] = areas.geometry.buffer(0)  # drops the stray lines and points intersections leave behind
    areas = areas[~areas.geometry.is_empty].to_crs("EPSG:4326")

    towns = gpd.read_file(towns_path)
    at = gpd.GeoDataFrame(geometry=areas.geometry.representative_point(), crs="EPSG:4326")
    joined = gpd.sjoin(at, towns[["geometry"]], how="left", predicate="within")
    areas["town"] = joined.groupby(level=0)["index_right"].first().reindex(areas.index).fillna(-1).astype(int)
    for col in ["people", "households", "no_vehicle", "no_vehicle_people"]:
        areas[col] = areas[col].round(2)
    areas.to_file(out, driver="GeoJSON")
    for zone, group in areas.groupby("zone"):
        print(f"households ({zone}): {len(group)} block areas, {group['people'].sum():,.0f} people, "
              f"{group['households'].sum():,.0f} households, {group['no_vehicle'].sum():,.0f} without a vehicle")
    print(f"saved {out}")


def fetch_roads(district_poly, out: Path):
    # Buffer so roads crossing the line keep both endpoints; those become exits.
    area = gpd.GeoSeries([district_poly], crs="EPSG:4326").to_crs(NJ_CRS).buffer(1000).to_crs("EPSG:4326")[0]
    graph = ox.graph_from_polygon(area, network_type="drive", retain_all=False)
    graph = ox.add_edge_speeds(graph)
    graph = ox.add_edge_travel_times(graph)
    ox.save_graphml(graph, out)
    print(f"roads: {graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges, saved {out}")


def fetch_flood(district_poly, out: Path):
    # The NFHL service times out on large envelopes, so query a grid of tiles.
    minx, miny, maxx, maxy = district_poly.bounds
    step = 0.05
    features = []
    x = minx
    while x < maxx:
        y = miny
        while y < maxy:
            features += query_nfhl((x, y, min(x + step, maxx), min(y + step, maxy)))
            y += step
        x += step

    zones = gpd.GeoDataFrame.from_features(features, crs="EPSG:4326")
    zones = zones.drop_duplicates(subset="FLD_AR_ID")
    # Server-side generalization can leave self-intersecting rings, which GEOS refuses to clip.
    zones["geometry"] = zones.geometry.make_valid()
    zones = gpd.clip(zones, district_poly)
    zones = zones[zones.geom_type.isin(["Polygon", "MultiPolygon"])]
    zones[["FLD_ZONE", "geometry"]].to_file(out, driver="GeoJSON")
    print(f"flood: {len(zones)} special flood hazard polygons, saved {out}")


def query_nfhl(bbox):
    features = []
    offset = 0
    while True:
        resp = session.get(NFHL_URL, params={
            "where": "SFHA_TF = 'T'",
            "geometry": ",".join(map(str, bbox)),
            "geometryType": "esriGeometryEnvelope",
            "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "FLD_AR_ID,FLD_ZONE",
            "outSR": 4326,
            # ~10 m generalization; full-detail polygons are tens of MB for no visual gain.
            "maxAllowableOffset": 0.0001,
            "resultOffset": offset,
            "resultRecordCount": 2000,
            "f": "geojson",
        }, timeout=120)
        resp.raise_for_status()
        page = resp.json()
        if "error" in page:
            raise RuntimeError(f"NFHL error for {bbox}: {page['error']}")
        features += page["features"]
        if not page.get("properties", {}).get("exceededTransferLimit") and not page.get("exceededTransferLimit"):
            return features
        offset += len(page["features"])


def export_web(out: Path):
    """Write everything the browser sim needs as plain arrays, so it never touches geometry at runtime."""
    import numpy as np
    from shapely.geometry import Point

    import sim

    out.mkdir(parents=True, exist_ok=True)
    flood_geoms = list(gpd.read_file(DATA / "flood.geojson").geometry)
    district = unary_union(gpd.read_file(DATA / "district.geojson").geometry)
    towns = gpd.read_file(DATA / "towns.geojson")
    town_names = towns["name"].tolist()
    # dt only scales flow_cap, which the browser recomputes from per-hour capacity.
    net = sim.Network(ox.load_graphml(DATA / "roads.graphml"), dt=3600.0)
    flooded = sim.flooded_edges(net, flood_geoms)

    # Index len(town_names) means "outside every NJ-12 town" (the buffer ring around the district).
    node_points = [Point(xy) for xy in net.node_xy]
    hit_node, hit_town = STRtree(list(towns.geometry)).query(node_points, predicate="within")
    node_town = np.full(net.n_nodes, len(town_names), dtype=np.int32)
    node_town[hit_node] = hit_town

    # A two-way street is two directed edges with the same geometry; the map draws and closes it as one road.
    key = {}
    seg_of_edge = np.empty(net.n_edges, dtype=np.int32)
    for e in range(net.n_edges):
        a, b = int(net.u[e]), int(net.v[e])
        seg_of_edge[e] = key.setdefault((min(a, b), max(a, b), round(net.length[e])), len(key))
    n_segs = len(key)
    seg_rep = np.full(n_segs, -1, dtype=np.int64)
    for e in range(net.n_edges - 1, -1, -1):
        seg_rep[seg_of_edge[e]] = e
    seg_storage = np.bincount(seg_of_edge, weights=net.storage_cap, minlength=n_segs).astype(np.int32)
    seg_flooded = np.bincount(seg_of_edge, weights=flooded, minlength=n_segs) > 0
    seg_flooded_bridge = np.bincount(seg_of_edge, weights=net.bridge & flooded, minlength=n_segs) > 0
    seg_twoway = np.bincount(seg_of_edge, minlength=n_segs) > 1
    seg_town = node_town[net.u[seg_rep]]
    mids = [net.geoms[e].interpolate(0.5, normalized=True) for e in seg_rep]

    homes = gpd.read_file(DATA / "households.geojson")
    area_group = np.where(homes["zone"] == "shadow", sim.SHADOW, sim.FLOOD_ZONE)
    # One evacuating car per household that has a vehicle; households without one need another way out.
    vehicle_households = (homes["households"] - homes["no_vehicle"]).clip(lower=0).to_numpy()
    destinations, usable = sim.safe_destinations(net, flood_geoms, district)
    expected = sim.expected_cars(net, usable, list(homes.geometry), vehicle_households, area_group)

    flood_homes = homes[homes["zone"] == "flood"]
    home_town = flood_homes["town"].where(flood_homes["town"] >= 0, len(town_names)).to_numpy()
    town_demand = {col: np.round(np.bincount(home_town, weights=flood_homes[col], minlength=len(town_names) + 1), 2)
                   .tolist() for col in ["people", "households", "no_vehicle", "no_vehicle_people"]}
    shadow_homes = homes[homes["zone"] == "shadow"]

    arrays = {
        "node_x": net.node_xy[:, 0], "node_y": net.node_xy[:, 1],
        "node_town": node_town, "destination": destinations.astype(np.uint8),
        "expected_flood": expected[sim.FLOOD_ZONE], "expected_shadow": expected[sim.SHADOW],
        "edge_u": net.u.astype(np.int32), "edge_v": net.v.astype(np.int32),
        "free_time": net.free_time, "flow_vph": net.flow_cap.astype(np.float64),
        "storage_cap": net.storage_cap.astype(np.int32), "seg_of_edge": seg_of_edge,
        "seg_mid_x": np.array([p.x for p in mids]), "seg_mid_y": np.array([p.y for p in mids]),
        "seg_flooded_bridge": seg_flooded_bridge.astype(np.uint8),
    }
    manifest, blobs, offset = {}, [], 0
    for name, arr in arrays.items():
        raw = np.ascontiguousarray(arr).tobytes()
        manifest[name] = [arr.dtype.name, offset, len(arr)]
        pad = -len(raw) % 8  # typed-array views need offsets aligned to their element size
        blobs.append(raw + b"\0" * pad)
        offset += len(raw) + pad
    (out / "network.bin").write_bytes(b"".join(blobs))

    paths = [[[round(x, 5), round(y, 5)] for x, y in net.geoms[e].simplify(0.00002).coords] for e in seg_rep]
    flags = (net.bridge[seg_rep].astype(int) | seg_flooded.astype(int) << 1 | (~seg_twoway).astype(int) << 2)
    minx, miny, maxx, maxy = district.bounds
    payload = {
        "arrays": manifest,
        "n_nodes": net.n_nodes, "n_edges": net.n_edges, "n_segs": n_segs,
        "paths": paths, "classes": [net.highway[e] for e in seg_rep], "names": [net.names[e] for e in seg_rep],
        "flags": flags.tolist(), "storage": seg_storage.tolist(), "town": seg_town.tolist(),
        "towns": town_names + ["Outside NJ-12"], "bounds": [minx, miny, maxx, maxy],
        "demand": town_demand,
        "shadow_households": float(shadow_homes["households"].sum()),
    }
    (out / "network.json").write_text(json.dumps(payload, separators=(",", ":")))
    for name in ["flood", "district"]:
        shutil.copy(DATA / f"{name}.geojson", out / f"{name}.geojson")
    (out / "towns.geojson").write_text(towns.to_json())
    print(f"web: {net.n_nodes} nodes, {net.n_edges} edges, {n_segs} roads, "
          f"{expected[sim.FLOOD_ZONE].sum():,.0f} flood-zone + {expected[sim.SHADOW].sum():,.0f} shadow cars at 100%, "
          f"saved {out}")


def main():
    parser = argparse.ArgumentParser(description="Download district boundary, roads, flood zones, towns, and households.")
    parser.add_argument("--district", default="12", help="NJ congressional district, two digits (default 12)")
    parser.add_argument("--force", action="store_true", help="refetch even if cached files exist")
    args = parser.parse_args()

    DATA.mkdir(exist_ok=True)
    district_path = DATA / "district.geojson"
    roads_path = DATA / "roads.graphml"
    flood_path = DATA / "flood.geojson"
    towns_path = DATA / "towns.geojson"
    households_path = DATA / "households.geojson"

    if args.force or not district_path.exists():
        fetch_district(args.district.zfill(2), district_path)
    district_poly = unary_union(gpd.read_file(district_path).geometry)

    if args.force or not roads_path.exists():
        fetch_roads(district_poly, roads_path)
    if args.force or not flood_path.exists():
        fetch_flood(district_poly, flood_path)
    if args.force or not towns_path.exists():
        fetch_towns(district_poly, towns_path)
    if args.force or not households_path.exists():
        fetch_households(district_poly, flood_path, towns_path, households_path)
    if args.force or not (WEB_DATA / "network.bin").exists():
        export_web(WEB_DATA)


if __name__ == "__main__":
    main()
