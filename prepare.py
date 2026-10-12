import argparse
import io
from pathlib import Path

import geopandas as gpd
import pandas as pd
import osmnx as ox
import requests
from requests.adapters import HTTPAdapter
from shapely.ops import unary_union
from urllib3.util.retry import Retry

DATA = Path(__file__).parent / "data"
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
    blocks = blocks[blocks.intersects(district)]
    flood = unary_union(gpd.read_file(flood_path).to_crs(NJ_CRS).geometry)
    wet = blocks.geometry.intersection(flood)
    frac = (wet.area / blocks.geometry.area).clip(0, 1)
    keep = frac > 0.001

    # Within a block, residents are assumed spread evenly, so the flooded share of its area is the flooded share of its people.
    areas = gpd.GeoDataFrame({
        "block": blocks["GEOID20"][keep],
        "people": (blocks["POP20"] * frac)[keep],
        "households": (blocks["households"] * frac)[keep],
        "no_vehicle": (blocks["no_vehicle"] * frac)[keep],
        "no_vehicle_people": (blocks["no_vehicle_people"] * frac)[keep],
    }, geometry=wet[keep], crs=NJ_CRS)
    areas = areas[areas.geom_type.isin(["Polygon", "MultiPolygon"]) | areas.geometry.geom_type.eq("GeometryCollection")]
    areas["geometry"] = areas.geometry.buffer(0)
    areas = areas[~areas.geometry.is_empty].to_crs("EPSG:4326")

    towns = gpd.read_file(towns_path)
    at = gpd.GeoDataFrame(geometry=areas.geometry.representative_point(), crs="EPSG:4326")
    joined = gpd.sjoin(at, towns[["geometry"]], how="left", predicate="within")
    areas["town"] = joined.groupby(level=0)["index_right"].first().reindex(areas.index).fillna(-1).astype(int)
    for col in ["people", "households", "no_vehicle", "no_vehicle_people"]:
        areas[col] = areas[col].round(2)
    areas.to_file(out, driver="GeoJSON")
    print(f"households: {len(areas)} flooded block areas, {areas['people'].sum():,.0f} people, "
          f"{areas['households'].sum():,.0f} households, {areas['no_vehicle'].sum():,.0f} without a vehicle, saved {out}")


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


if __name__ == "__main__":
    main()
