import argparse
import gzip
import json
import threading
import time
from pathlib import Path

import geopandas as gpd
import numpy as np
import osmnx as ox
from flask import Flask, Response, jsonify, request, send_from_directory
from shapely import STRtree
from shapely.geometry import Point
from shapely.ops import unary_union

import sim

ROOT = Path(__file__).parent
DATA = ROOT / "data"
DT = 5.0
TICK_S = 0.1
SPEEDS = [1, 3, 6, 12]  # sim steps per tick


class World:
    """Everything the HTTP handlers touch, guarded by one lock."""

    def __init__(self, n_cars: int):
        self.lock = threading.Lock()
        self.changed = threading.Condition(self.lock)

        flood = gpd.read_file(DATA / "flood.geojson")
        self.flood_geoms = list(flood.geometry)
        self.flood_json = gzip.compress((DATA / "flood.geojson").read_bytes())
        district_gdf = gpd.read_file(DATA / "district.geojson")
        self.district = unary_union(district_gdf.geometry)
        self.district_json = gzip.compress((DATA / "district.geojson").read_bytes())
        towns = gpd.read_file(DATA / "towns.geojson")
        self.town_names = towns["name"].tolist()
        self.towns_json = gzip.compress(towns.to_json().encode())

        self.net = sim.Network(ox.load_graphml(DATA / "roads.graphml"), dt=DT)
        self.flooded = sim.flooded_edges(self.net, self.flood_geoms)
        # Index len(town_names) means "outside every NJ-12 town" (the buffer ring around the district).
        node_points = [Point(xy) for xy in self.net.node_xy]
        hit_node, hit_town = STRtree(list(towns.geometry)).query(node_points, predicate="within")
        self.node_town = np.full(self.net.n_nodes, len(self.town_names), dtype=np.int64)
        self.node_town[hit_node] = hit_town
        self.build_segments()
        self.network_json = gzip.compress(json.dumps(self.network_payload(), separators=(",", ":")).encode())

        self.n_cars = n_cars
        self.scenario = sim.build_scenario(self.net, self.flood_geoms, self.district, n_cars, window_s=3600)
        self.car_town = self.node_town[self.scenario.origins]
        self.sim = sim.Sim(self.net, self.scenario, dt=DT)
        self.running = False
        self.speed = SPEEDS[2]
        self.run_id = 0
        self.version = 0
        # Evacuation curves for this run and the last, so a reloaded page can redraw the comparison chart.
        self.history = [(0.0, 0)]
        self.previous = None
        # Closures in force while this run was live; edits made after it finishes belong to the next run.
        self.run_closed = 0
        self.snapshot = self.make_snapshot()

    def build_segments(self):
        # A two-way street is two directed edges with the same geometry; the map draws and closes it as one road.
        net = self.net
        key = {}
        self.seg_of_edge = np.empty(net.n_edges, dtype=np.int64)
        for e in range(net.n_edges):
            a, b = int(net.u[e]), int(net.v[e])
            k = (min(a, b), max(a, b), round(net.length[e]))
            self.seg_of_edge[e] = key.setdefault(k, len(key))
        self.n_segs = len(key)
        self.seg_edges = [[] for _ in range(self.n_segs)]
        for e, s in enumerate(self.seg_of_edge):
            self.seg_edges[s].append(e)
        self.seg_rep = np.array([edges[0] for edges in self.seg_edges])
        seg_storage = np.zeros(self.n_segs, dtype=np.int64)
        np.add.at(seg_storage, self.seg_of_edge, net.storage_cap)
        self.seg_storage = seg_storage
        flooded_bridge = np.zeros(self.n_segs, dtype=bool)
        np.logical_or.at(flooded_bridge, self.seg_of_edge, net.bridge & self.flooded)
        self.seg_flooded_bridge = flooded_bridge
        self.seg_town = self.node_town[net.u[self.seg_rep]]
        mids = [net.geoms[e].interpolate(0.5, normalized=True) for e in self.seg_rep]
        self.seg_mid = np.round([(p.x, p.y) for p in mids], 5)

    def network_payload(self) -> dict:
        net = self.net
        paths, classes, names, flags = [], [], [], []
        for s, e in enumerate(self.seg_rep):
            coords = net.geoms[e].simplify(0.00002).coords
            paths.append([[round(x, 5), round(y, 5)] for x, y in coords])
            classes.append(net.highway[e])
            names.append(net.names[e])
            edges = self.seg_edges[s]
            flags.append(int(net.bridge[e]) | int(self.flooded[edges].any()) << 1 | int(len(edges) == 1) << 2)
        minx, miny, maxx, maxy = self.district.bounds
        return {"paths": paths, "classes": classes, "names": names, "flags": flags,
                "storage": self.seg_storage.tolist(), "town": self.seg_town.tolist(),
                "towns": self.town_names + ["Outside NJ-12"], "bounds": [minx, miny, maxx, maxy]}

    def closed_segments(self) -> list:
        return np.flatnonzero(np.bincount(self.seg_of_edge, weights=self.net.closed, minlength=self.n_segs) > 0).tolist()

    def make_snapshot(self) -> dict:
        s = self.sim
        busy = np.flatnonzero(s.occupancy > 0)
        segs = self.seg_of_edge[busy]
        queued = np.zeros(self.n_segs, dtype=np.int64)
        np.add.at(queued, segs, s.occupancy[busy])
        load = np.zeros(self.n_segs)
        np.maximum.at(load, segs, np.minimum(s.occupancy[busy] / self.net.storage_cap[busy], 1.0))
        active = np.unique(segs)
        return {
            "run": self.run_id,
            "t": s.t,
            "counts": s.counts(),
            "total": self.n_cars,
            "done": bool(s.done()),
            "running": self.running,
            "speed": self.speed,
            "segs": active.tolist(),
            "load": np.round(load[active], 3).tolist(),
            "queued": queued[active].tolist(),
            "closed": self.closed_segments(),
        }

    def publish(self):
        if self.sim.t > self.history[-1][0]:
            self.history.append((self.sim.t, self.sim.counts()["evacuated"]))
        self.snapshot = self.make_snapshot()
        self.version += 1
        self.changed.notify_all()

    def reset(self, n_cars=None):
        if len(self.history) > 2:
            self.previous = {"total": self.n_cars, "done": bool(self.sim.done()), "points": self.history,
                             "summary": self.summary()}
        if n_cars and n_cars != self.n_cars:
            self.n_cars = n_cars
            self.scenario = sim.build_scenario(self.net, self.flood_geoms, self.district, n_cars, window_s=3600)
            self.car_town = self.node_town[self.scenario.origins]
        # Closures are part of the scenario a planner is testing, so they survive a reset.
        self.sim = sim.Sim(self.net, self.scenario, dt=DT)
        self.history = [(0.0, 0)]
        self.run_closed = len(self.closed_segments())
        self.run_id += 1
        self.running = False

    def set_segments(self, segs, closed: bool) -> dict:
        edges = [e for s in segs for e in self.seg_edges[s]]
        changing = np.zeros(self.net.n_edges, dtype=bool)
        changing[edges] = self.net.closed[edges] != closed
        # Measured on the routes in force before the change: these are the drivers who must find another way.
        affected = self.sim.cars_affected(changing) if closed else 0
        self.net.closed[edges] = closed
        self.sim.reroute()
        if not self.sim.done():
            self.run_closed = len(self.closed_segments())
        return {"changed": int(len(np.unique(self.seg_of_edge[changing]))), "affected": affected}

    def per_seg(self, per_edge) -> np.ndarray:
        return np.bincount(self.seg_of_edge, weights=per_edge, minlength=self.n_segs)

    def time_to(self, fraction: float, history, total: int):
        for t, evacuated in history:
            if evacuated >= fraction * total:
                return round(t / 60, 1)
        return None

    def summary(self) -> dict:
        s = self.sim
        counts = s.counts()
        seg_delay = self.per_seg(s.delay_s)
        worst = int(seg_delay.argmax())
        return {
            "cars": self.n_cars,
            "closed": self.run_closed,
            "done": bool(s.done()),
            "cleared_min": round(s.t / 60, 1) if s.done() else None,
            "t50_min": self.time_to(0.5, self.history, self.n_cars),
            "t90_min": self.time_to(0.9, self.history, self.n_cars),
            "evacuated": counts["evacuated"],
            "stranded": counts["stranded"],
            **{k: (round(v, 2) if v is not None else None) for k, v in s.trip_stats().items()},
            "worst_road": (self.net.names[self.seg_rep[worst]] or "Unnamed road") if seg_delay[worst] > 0 else None,
        }

    def stats(self) -> dict:
        s = self.sim
        n_towns = len(self.town_names) + 1
        ct = self.car_town
        evac = s.state == sim.EVACUATED
        stranded = s.state == sim.STRANDED
        cars = np.bincount(ct, minlength=n_towns)
        out = np.bincount(ct[evac], minlength=n_towns)
        stuck = np.bincount(ct[stranded], minlength=n_towns)
        last = np.zeros(n_towns)
        np.maximum.at(last, ct[evac], s.arrive_t[evac])
        trip = s.arrive_t - s.scenario.depart
        delay = trip - s.free_trip
        towns = []
        for k in np.flatnonzero(cars):
            mine = evac & (ct == k)
            remaining = int(cars[k] - out[k] - stuck[k])
            towns.append({
                "town": int(k), "cars": int(cars[k]), "evacuated": int(out[k]), "stranded": int(stuck[k]),
                "remaining": remaining,
                "cleared_min": round(last[k] / 60, 1) if remaining == 0 and out[k] else None,
                "median_min": round(float(np.median(trip[mine])) / 60, 1) if mine.any() else None,
                "delay_min": round(float(np.nanmean(np.where(np.isfinite(delay[mine]), delay[mine], np.nan))) / 60, 1)
                if mine.any() else None,
            })

        seg_delay = self.per_seg(s.delay_s) / 60  # vehicle-minutes
        seg_flow = self.per_seg(s.planned_flow())
        seg_queue = self.per_seg(s.occupancy)
        closed = set(self.closed_segments())
        bottlenecks = [{
            "seg": int(g), "delay_veh_h": round(seg_delay[g] / 60, 1), "queued": int(seg_queue[g]),
            "flow": int(seg_flow[g]), "town": int(self.seg_town[g]), "at": self.seg_mid[g].tolist(),
            "closed": int(g) in closed,
        } for g in np.argsort(seg_delay)[::-1][:12] if seg_delay[g] > 0]

        stuck_nodes = np.bincount(s.stranded_at[stranded], minlength=self.net.n_nodes)
        nodes = np.flatnonzero(stuck_nodes)
        stranded_points = [[*np.round(self.net.node_xy[n], 5).tolist(), int(stuck_nodes[n]), int(self.node_town[n])]
                           for n in nodes]

        delayed = np.flatnonzero(seg_delay >= 0.5)
        routed = np.flatnonzero(seg_flow > 0)
        return {
            "run": self.run_id,
            "t": s.t,
            "summary": self.summary(),
            "previous": self.previous and self.previous["summary"],
            "towns": towns,
            "bottlenecks": bottlenecks,
            "stranded": stranded_points,
            "delay": {"segs": delayed.tolist(), "veh_min": np.round(seg_delay[delayed], 1).tolist()},
            "flow": {"segs": routed.tolist(), "cars": seg_flow[routed].astype(int).tolist()},
        }

    def loop(self):
        while True:
            started = time.monotonic()
            with self.lock:
                if self.running:
                    for _ in range(self.speed):
                        self.sim.step()
                        if self.sim.done():
                            self.running = False
                            break
                    self.publish()
            time.sleep(max(0.0, TICK_S - (time.monotonic() - started)))


app = Flask(__name__, static_folder=None)
world: World


def gzipped(body: bytes, mimetype="application/json"):
    return Response(body, mimetype=mimetype, headers={"Content-Encoding": "gzip", "Cache-Control": "no-cache"})


@app.get("/")
def index():
    return send_from_directory(ROOT / "static", "index.html")


@app.get("/static/<path:name>")
def static_file(name):
    return send_from_directory(ROOT / "static", name)


@app.get("/network")
def network():
    return gzipped(world.network_json)


@app.get("/flood")
def flood():
    return gzipped(world.flood_json, "application/geo+json")


@app.get("/towns")
def towns():
    return gzipped(world.towns_json, "application/geo+json")


@app.get("/stats")
def stats():
    with world.lock:
        return jsonify(world.stats())


@app.get("/district")
def district():
    return gzipped(world.district_json, "application/geo+json")


@app.get("/state")
def state():
    with world.lock:
        return jsonify(world.snapshot | {"speeds": SPEEDS, "history": world.history, "previous": world.previous})


@app.get("/stream")
def stream():
    def events():
        seen = -1
        while True:
            with world.lock:
                world.changed.wait_for(lambda: world.version != seen, timeout=15)
                if world.version == seen:
                    payload = None
                else:
                    seen = world.version
                    payload = json.dumps(world.snapshot, separators=(",", ":"))
            # A comment line keeps idle connections from being closed by proxies and the browser.
            yield f"data: {payload}\n\n" if payload else ": keepalive\n\n"

    return Response(events(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache"})


def segments_from_request() -> list:
    body = request.get_json(force=True)
    segs = body.get("segs", [body["seg"]] if "seg" in body else [])
    bad = [s for s in segs if not (isinstance(s, int) and 0 <= s < world.n_segs)]
    if bad:
        raise ValueError(f"unknown segments {bad[:5]}")
    return segs


@app.errorhandler(ValueError)
def bad_request(err):
    return jsonify(error=str(err)), 400


def mutate(fn):
    with world.lock:
        result = fn()
        world.publish()
        return jsonify(result if isinstance(result, dict) else {"ok": True})


@app.post("/close")
def close():
    segs = segments_from_request()
    return mutate(lambda: world.set_segments(segs, True))


@app.post("/open")
def open_():
    segs = segments_from_request()
    return mutate(lambda: world.set_segments(segs, False))


@app.post("/close-flooded-bridges")
def close_flooded_bridges():
    return mutate(lambda: world.set_segments(np.flatnonzero(world.seg_flooded_bridge).tolist(), True))


@app.post("/open-all")
def open_all():
    return mutate(lambda: world.set_segments(world.closed_segments(), False))


@app.post("/play")
def play():
    def go():
        if world.sim.done():
            world.reset()
        world.running = True
    return mutate(go)


@app.post("/pause")
def pause():
    return mutate(lambda: setattr(world, "running", False))


@app.post("/speed")
def speed():
    steps = request.get_json(force=True)["steps"]
    if steps not in SPEEDS:
        raise ValueError(f"speed must be one of {SPEEDS}")
    return mutate(lambda: setattr(world, "speed", steps))


@app.post("/reset")
def reset():
    n_cars = request.get_json(silent=True, force=True) or {}
    n_cars = n_cars.get("cars")
    if n_cars is not None and not (isinstance(n_cars, int) and 1000 <= n_cars <= 200_000):
        raise ValueError("cars must be an integer between 1,000 and 200,000")
    return mutate(lambda: world.reset(n_cars))


def main():
    global world
    parser = argparse.ArgumentParser()
    parser.add_argument("--cars", type=int, default=40_000)
    parser.add_argument("--port", type=int, default=5050)  # 5000 is taken by AirPlay on macOS
    args = parser.parse_args()

    world = World(args.cars)
    threading.Thread(target=world.loop, daemon=True).start()
    print(f"evacsim: {world.n_segs} roads, {args.cars} cars, http://localhost:{args.port}")
    app.run(port=args.port, threaded=True)


if __name__ == "__main__":
    main()
