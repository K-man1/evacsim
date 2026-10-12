from collections import deque

import networkx as nx
import numpy as np
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra
from shapely import STRtree
from shapely.geometry import LineString, Point

# Vehicles per hour per lane at saturation, by OSM highway class.
LANE_FLOW = {
    "motorway": 2000, "trunk": 1800, "primary": 1800, "secondary": 1500,
    "tertiary": 1200, "unclassified": 900, "residential": 900, "living_street": 600,
}
DEFAULT_LANES = {"motorway": 2, "trunk": 2}
ARTERIAL = {"motorway", "trunk", "primary"}
RESIDENTIAL = {"residential", "living_street", "unclassified"}
CAR_SPACING_M = 7.5

WAITING, ON_ROAD, EVACUATED, STRANDED = range(4)
ARRIVE = -2
NO_ROUTE = -1


def base_class(highway) -> str:
    if isinstance(highway, list):
        highway = highway[0]
    return highway.removesuffix("_link")


def parse_lanes(raw, oneway: bool, cls: str) -> int:
    if isinstance(raw, list):
        raw = raw[0]
    try:
        total = int(float(raw))
    except (TypeError, ValueError):
        return DEFAULT_LANES.get(cls, 1)
    # OSM `lanes` counts both directions on two-way roads.
    return max(1, total if oneway else total // 2)


class Network:
    def __init__(self, graph: nx.MultiDiGraph, dt: float):
        self.node_ids = list(graph.nodes)
        index = {n: i for i, n in enumerate(self.node_ids)}
        self.node_xy = np.array([(graph.nodes[n]["x"], graph.nodes[n]["y"]) for n in self.node_ids])

        u, v, length, free_time, lanes, classes, names, geoms, bridge = [], [], [], [], [], [], [], [], []
        for a, b, attrs in graph.edges(data=True):
            cls = base_class(attrs.get("highway", "residential"))
            u.append(index[a])
            v.append(index[b])
            length.append(float(attrs["length"]))
            free_time.append(float(attrs["travel_time"]))
            lanes.append(parse_lanes(attrs.get("lanes"), bool(attrs.get("oneway", False)), cls))
            classes.append(cls)
            bridge.append(attrs.get("bridge") not in (None, "no"))
            name = attrs.get("name") or attrs.get("ref") or ""
            names.append(name[0] if isinstance(name, list) else name)
            geom = attrs.get("geometry")
            if geom is None:
                geom = LineString([self.node_xy[index[a]], self.node_xy[index[b]]])
            geoms.append(geom)

        self.u = np.array(u)
        self.v = np.array(v)
        self.length = np.array(length)
        self.free_time = np.array(free_time)
        self.lanes = np.array(lanes)
        self.highway = classes
        self.bridge = np.array(bridge)
        self.names = names
        self.geoms = geoms
        self.n_nodes = len(self.node_ids)
        self.n_edges = len(u)

        per_lane = np.array([LANE_FLOW.get(c, 900) for c in classes])
        self.flow_cap = self.lanes * per_lane * dt / 3600.0
        self.storage_cap = np.maximum(1, np.floor(self.lanes * self.length / CAR_SPACING_M)).astype(int)
        self.closed = np.zeros(self.n_edges, dtype=bool)


FLOOD_ZONE, SHADOW = 0, 1

# Departure curves, as the Rayleigh scale in seconds: the minute departures peak. 95% have left by 2.45x that.
# Rayleigh-shaped mobilization curves are a common choice in evacuation modeling: a slow start while people
# hear the order and pack, a peak, then a long tail of late leavers.
DEPARTURE_PEAK_S = {
    "sudden": 10 * 60,  # flash flood or overnight surge: 95% gone within ~25 min
    "short": 25 * 60,   # a few hours of warning: 95% gone within ~1 h
    "long": 75 * 60,    # day-ahead order: 95% gone within ~3 h
}


def departure_times(n: int, peak_s: float) -> np.ndarray:
    """Evenly spaced quantiles of a Rayleigh curve, so a run's departures match the curve exactly."""
    q = (np.arange(n) + 0.5) / n
    return peak_s * np.sqrt(-2 * np.log1p(-q))


class Scenario:
    """Who evacuates, from where, when, and what counts as safe."""

    def __init__(self, origins, depart, destinations, group=None):
        self.origins = origins
        self.depart = depart
        self.destinations = destinations
        self.group = np.zeros(len(origins), dtype=np.int8) if group is None else group


def flooded_edges(net: Network, flood_geoms) -> np.ndarray:
    tree = STRtree(flood_geoms)
    hits = tree.query(net.geoms, predicate="intersects")
    flooded = np.zeros(net.n_edges, dtype=bool)
    flooded[np.unique(hits[0])] = True
    return flooded


def safe_destinations(net: Network, flood_geoms, district, safe_buffer_deg: float = 0.002):
    """Nodes that count as safe, and nodes a car can usefully start from."""
    points = [Point(xy) for xy in net.node_xy]

    # ~200 m at NJ latitudes. Dry ground means clear of the floodplain by a margin, not just past its edge.
    buffered = STRtree([g.buffer(safe_buffer_deg) for g in flood_geoms])
    near_flood = np.zeros(net.n_nodes, dtype=bool)
    near_flood[np.unique(buffered.query(points, predicate="intersects")[0])] = True

    on_arterial = np.zeros(net.n_nodes, dtype=bool)
    for e, cls in enumerate(net.highway):
        if cls in ARTERIAL:
            on_arterial[net.u[e]] = on_arterial[net.v[e]] = True
    outside_district = ~np.array([district.contains(p) for p in points])
    destinations = (on_arterial | outside_district) & ~near_flood

    # Cars can't start where they'd count as safe on the spot, or at intersections with no way to dry ground
    # even with every road open (one-way stubs at the edge of the OSM extract): those would only report
    # data gaps as stranded residents.
    reverse = csr_matrix((np.ones(net.n_edges), (net.v, net.u)), shape=(net.n_nodes, net.n_nodes))
    dist = dijkstra(reverse, indices=np.flatnonzero(destinations), min_only=True, unweighted=True)
    usable = np.isfinite(dist) & ~destinations
    return destinations, usable


def expected_cars(net: Network, usable, home_areas, cars_per_area, area_group) -> np.ndarray:
    """Expected starting cars per node, one row per group (FLOOD_ZONE, SHADOW).

    Linear in `cars_per_area`, so scaling a group's row scales that group's evacuation rate.
    """
    points = [Point(xy) for xy in net.node_xy]
    street = np.zeros(net.n_nodes)
    for e, cls in enumerate(net.highway):
        if cls in RESIDENTIAL:
            street[net.u[e]] += net.length[e]

    cars_per_area = np.asarray(cars_per_area, dtype=float)
    area_group = np.asarray(area_group)
    node_tree = STRtree(points)
    usable_nodes = np.flatnonzero(usable)
    usable_tree = STRtree([points[n] for n in usable_nodes])
    area_idx, node_idx = node_tree.query(home_areas, predicate="contains")
    area_idx, node_idx = area_idx[usable[node_idx]], node_idx[usable[node_idx]]
    # Within an area, cars start at intersections in proportion to the residential street leaving them.
    pair_weight = street[node_idx]
    area_total = np.bincount(area_idx, weights=pair_weight, minlength=len(home_areas))
    pair_weight[area_total[area_idx] == 0] = 1.0  # an area with only non-residential intersections still uses them
    area_total = np.bincount(area_idx, weights=pair_weight, minlength=len(home_areas))
    # Small flooded slivers of a block often contain no intersection; their cars start at the nearest one.
    empty = np.flatnonzero(np.bincount(area_idx, minlength=len(home_areas)) == 0)
    nearest = usable_nodes[usable_tree.nearest([home_areas[a].representative_point() for a in empty])] \
        if len(empty) else np.array([], dtype=np.int64)

    expected = np.zeros((2, net.n_nodes))
    for g in (FLOOD_ZONE, SHADOW):
        cars = np.where(area_group == g, cars_per_area, 0.0)
        np.add.at(expected[g], node_idx, cars[area_idx] * pair_weight / area_total[area_idx])
        np.add.at(expected[g], nearest, cars[empty])
    return expected


def build_scenario(net: Network, flood_geoms, district, home_areas, cars_per_area, area_group,
                   departure_peak_s: float, safe_buffer_deg: float = 0.002, seed: int = 0) -> Scenario:
    """Place cars on the streets of each home area; send them to the nearest dry arterial or exit.

    `home_areas` are polygons where people live, `cars_per_area` the expected evacuating cars from each,
    and `area_group` marks each area FLOOD_ZONE or SHADOW (outside the zone but leaving anyway).
    """
    rng = np.random.default_rng(seed)
    destinations, usable = safe_destinations(net, flood_geoms, district, safe_buffer_deg)
    expected = expected_cars(net, usable, home_areas, cars_per_area, area_group)

    origins, group = [], []
    for g in (FLOOD_ZONE, SHADOW):
        n = int(round(expected[g].sum()))
        # Largest-remainder rounding: every intersection gets its expected count, not a random draw around it.
        counts = np.floor(expected[g]).astype(np.int64)
        counts[np.argsort(counts - expected[g], kind="stable")[:n - counts.sum()]] += 1
        origins.append(np.repeat(np.arange(net.n_nodes), counts))
        group.append(np.full(n, g, dtype=np.int8))
    origins, group = np.concatenate(origins), np.concatenate(group)
    if not len(origins):
        raise ValueError("no households to evacuate")

    # Which household leaves at which point on the curve is the one random choice left.
    order = rng.permutation(len(origins))
    return Scenario(origins[order], departure_times(len(origins), departure_peak_s), destinations, group[order])


class Sim:
    def __init__(self, net: Network, scenario: Scenario, dt: float = 5.0, reroute_every_s: float = 120.0,
                 adopt_fraction: float = 0.3, seed: int = 0):
        self.net = net
        self.scenario = scenario
        self.dt = dt
        self.reroute_every_s = reroute_every_s
        self.adopt_fraction = adopt_fraction
        self.rng = np.random.default_rng(seed)

        n = len(scenario.origins)
        self.t = 0.0
        self.state = np.full(n, WAITING, dtype=np.int8)
        self.tree_of = np.zeros(n, dtype=np.int32)
        self.next_departure = 0
        self.departed_waiting = deque()

        self.edge_of_car = np.full(n, -1, dtype=np.int64)
        self.arrive_t = np.full(n, np.nan)
        self.stranded_at = np.full(n, -1, dtype=np.int64)

        self.queues = [deque() for _ in range(net.n_edges)]
        self.occupancy = np.zeros(net.n_edges, dtype=np.int32)
        self.budget = np.zeros(net.n_edges)
        self.spill = np.zeros(net.n_edges, dtype=np.int32)
        # Vehicle-seconds lost per road: time cars spent past their free-flow exit, charged to the root bottleneck.
        self.delay_s = np.zeros(net.n_edges)
        self.held_by = {}
        self.ready_waiting = {}

        # The trip each car would make on an empty network with every road open; delay is measured against it.
        _, free_dist = self.shortest_tree(net.free_time, np.zeros(net.n_edges, dtype=bool))
        self.free_trip = free_dist[scenario.origins]

        self.trees = {}
        self.latest_tree = -1
        self.last_reroute = 0.0
        self.reroute()

    def counts(self) -> dict:
        tally = np.bincount(self.state, minlength=4)
        return {"waiting": int(tally[WAITING]), "on_road": int(tally[ON_ROAD]),
                "evacuated": int(tally[EVACUATED]), "stranded": int(tally[STRANDED])}

    def edge_weights(self) -> np.ndarray:
        # Expected traversal time if you joined the queue now: free-flow time plus time for the queue to drain.
        # At a bottleneck the queue is physically stored on the upstream roads, so `spill` charges those
        # cars to the road they're waiting to enter; otherwise a jammed bridge would look free.
        rate = self.net.flow_cap / self.dt
        return self.net.free_time + (self.occupancy + self.spill) / rate

    def shortest_tree(self, weights, closed):
        """Next edge and travel time from every node to its nearest destination."""
        net = self.net
        weights = np.maximum(weights, 0.01)  # scipy treats explicit zeros as missing edges
        open_edges = np.flatnonzero(~closed & (net.u != net.v))

        # Collapse parallel edges to the cheapest one so the sparse matrix maps (u, v) -> a single edge.
        order = open_edges[np.argsort(weights[open_edges], kind="stable")]
        pair = net.u[order].astype(np.int64) * net.n_nodes + net.v[order]
        _, first = np.unique(pair, return_index=True)
        best = order[first]

        sorted_pairs = pair[first]
        reverse = csr_matrix((weights[best], (net.v[best], net.u[best])), shape=(net.n_nodes, net.n_nodes))
        dests = np.flatnonzero(self.scenario.destinations)
        dist, pred, _ = dijkstra(reverse, indices=dests, min_only=True, return_predecessors=True)

        # pred[n] on the reversed graph is n's next node toward safety; look up the edge (n, pred[n]).
        next_edge = np.full(net.n_nodes, NO_ROUTE, dtype=np.int64)
        nodes = np.flatnonzero(pred >= 0)
        lookup = nodes.astype(np.int64) * net.n_nodes + pred[nodes]
        next_edge[nodes] = best[np.searchsorted(sorted_pairs, lookup)]
        next_edge[dests] = ARRIVE
        return next_edge, dist

    def reroute(self):
        next_edge, dist = self.shortest_tree(self.edge_weights(), self.net.closed)
        self.latest_dist = dist
        # Nodes ordered from nearest to safety outward; every node's next hop comes before it.
        routed = np.flatnonzero(next_edge >= 0)
        self.tree_order = routed[np.argsort(dist[routed], kind="stable")]

        self.latest_tree += 1
        self.trees[self.latest_tree] = next_edge
        self.last_reroute = self.t

        on_road = np.flatnonzero(self.state == ON_ROAD)
        adopters = on_road[self.rng.random(len(on_road)) < self.adopt_fraction]
        self.tree_of[adopters] = self.latest_tree
        self.tree_of[self.state == WAITING] = self.latest_tree
        live = set(np.unique(self.tree_of[self.state <= ON_ROAD]).tolist()) | {self.latest_tree}
        self.trees = {k: t for k, t in self.trees.items() if k in live}

    def next_hop(self, car: int, node: int) -> int:
        nxt = self.trees[self.tree_of[car]][node]
        if nxt == NO_ROUTE or (nxt >= 0 and self.net.closed[nxt]):
            # The car's plan is dead; it takes the current best plan regardless of the adoption lottery.
            self.tree_of[car] = self.latest_tree
            nxt = self.trees[self.latest_tree][node]
        return nxt

    def pending_nodes(self) -> np.ndarray:
        """The node each not-yet-safe car continues from: its origin, or the end of the road it's on."""
        waiting = self.state == WAITING
        on_road = self.state == ON_ROAD
        return np.concatenate([self.scenario.origins[waiting], self.net.v[self.edge_of_car[on_road]]])

    def planned_flow(self) -> np.ndarray:
        """Cars on each road now plus cars whose current best route still crosses it."""
        net = self.net
        nxt = self.trees[self.latest_tree]
        at_node = np.bincount(self.pending_nodes(), minlength=net.n_nodes).astype(np.int64)
        flow = self.occupancy.astype(np.int64)
        for node in self.tree_order[::-1]:
            cars = at_node[node]
            if cars:
                e = nxt[node]
                flow[e] += cars
                at_node[net.v[e]] += cars
        return flow

    def cars_affected(self, closing: np.ndarray) -> int:
        """How many cars' current best routes cross any edge in the `closing` mask."""
        nxt = self.trees[self.latest_tree]
        hits = np.zeros(self.net.n_nodes, dtype=bool)
        for node in self.tree_order:
            e = nxt[node]
            hits[node] = closing[e] or hits[self.net.v[e]]
        return int(hits[self.pending_nodes()].sum())

    def trip_stats(self, group: int | None = None) -> dict:
        done = self.state == EVACUATED
        if group is not None:
            done &= self.scenario.group == group
        trip = self.arrive_t[done] - self.scenario.depart[done]
        delay = trip - self.free_trip[done]
        delay = delay[np.isfinite(delay)]
        return {
            "median_min": float(np.median(trip) / 60) if len(trip) else None,
            "p90_min": float(np.percentile(trip, 90) / 60) if len(trip) else None,
            "mean_delay_min": float(delay.mean() / 60) if len(delay) else None,
            "delay_veh_h": float(self.delay_s.sum() / 3600),
        }

    def can_advance(self, edge: int, exit_time: float, nxt: int) -> bool:
        if exit_time > self.t or self.budget[edge] < 1:
            return False
        if nxt == ARRIVE:
            return True
        return not self.net.closed[nxt] and self.occupancy[nxt] < self.net.storage_cap[nxt]

    def enter(self, car: int, edge: int):
        self.queues[edge].append((car, self.t + self.net.free_time[edge]))
        self.occupancy[edge] += 1
        self.state[car] = ON_ROAD
        self.edge_of_car[car] = edge

    def evacuate(self, car: int):
        self.state[car] = EVACUATED
        self.arrive_t[car] = self.t
        self.edge_of_car[car] = -1

    def strand(self, car: int, node: int):
        self.state[car] = STRANDED
        self.stranded_at[car] = node
        self.edge_of_car[car] = -1

    def discharge(self, edge: int):
        queue = self.queues[edge]
        node = self.net.v[edge]
        while queue:
            car, exit_time = queue[0]
            nxt = self.next_hop(car, node)
            if nxt == NO_ROUTE:
                queue.popleft()
                self.occupancy[edge] -= 1
                self.strand(car, node)
                continue
            if not self.can_advance(edge, exit_time, nxt):
                if exit_time <= self.t:
                    downstream_full = nxt >= 0 and self.budget[edge] >= 1
                    if downstream_full:
                        self.spill[nxt] += len(queue)
                    # FIFO: every ready car behind the head is held by whatever holds the head.
                    ready = 0
                    for _, t_ready in queue:
                        if t_ready > self.t:
                            break
                        ready += 1
                    self.held_by[edge] = nxt if downstream_full else edge
                    self.ready_waiting[edge] = self.ready_waiting.get(edge, 0) + ready
                break
            queue.popleft()
            self.occupancy[edge] -= 1
            self.budget[edge] -= 1
            if nxt == ARRIVE:
                self.evacuate(car)
            else:
                self.enter(car, nxt)

    def depart(self):
        origins, times = self.scenario.origins, self.scenario.depart
        while self.next_departure < len(times) and times[self.next_departure] <= self.t:
            self.departed_waiting.append(self.next_departure)
            self.next_departure += 1

        # Cars whose first road is full stay in the driveway and try again next step.
        still_waiting = deque()
        for car in self.departed_waiting:
            nxt = self.next_hop(car, origins[car])
            if nxt == ARRIVE:
                self.evacuate(car)
            elif nxt == NO_ROUTE:
                self.strand(car, origins[car])
            elif not self.net.closed[nxt] and self.occupancy[nxt] < self.net.storage_cap[nxt]:
                self.enter(car, nxt)
            else:
                if not self.net.closed[nxt]:
                    self.spill[nxt] += 1
                    self.ready_waiting[nxt] = self.ready_waiting.get(nxt, 0) + 1
                still_waiting.append(car)
        self.departed_waiting = still_waiting

    def step(self):
        self.t += self.dt
        if self.t - self.last_reroute >= self.reroute_every_s:
            self.reroute()
        self.spill[:] = 0

        active = np.flatnonzero(self.occupancy > 0)
        # Fractional capacity carries over, capped so an idle road can't bank a burst.
        self.budget[active] = np.minimum(self.budget[active] + self.net.flow_cap[active],
                                         self.net.flow_cap[active] + 1.0)
        self.rng.shuffle(active)
        self.held_by.clear()
        self.ready_waiting.clear()
        for edge in active:
            self.discharge(edge)
        self.depart()
        for edge, ready in self.ready_waiting.items():
            self.delay_s[self.root_cause(edge)] += ready * self.dt

    def root_cause(self, edge: int) -> int:
        """Follow a chain of full roads downstream to the one limited by its own capacity."""
        seen = set()
        while True:
            cause = self.held_by.get(edge, edge)
            if cause == edge or cause in seen:  # self-limited, or gridlocked in a loop
                return cause
            seen.add(edge)
            edge = cause

    def set_closed(self, edge: int, closed: bool):
        self.net.closed[edge] = closed
        self.reroute()

    def close_many(self, edges):
        self.net.closed[edges] = True
        self.reroute()

    def done(self) -> bool:
        return self.next_departure == len(self.scenario.depart) and not self.departed_waiting \
            and not (self.state == ON_ROAD).any()

    def snapshot(self) -> dict:
        busy = np.flatnonzero(self.occupancy > 0)
        ratio = np.minimum(self.occupancy[busy] / self.net.storage_cap[busy], 1.0)
        return {
            "t": self.t,
            "counts": self.counts(),
            "edges": busy.tolist(),
            "load": np.round(ratio, 3).tolist(),
            "queued": self.occupancy[busy].tolist(),
        }
