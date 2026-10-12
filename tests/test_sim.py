import sys
from pathlib import Path

import networkx as nx
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))
import sim  # noqa: E402

DT = 5.0


def road(g, a, b, length=100.0, speed_mps=10.0, highway="residential", lanes=1):
    g.add_edge(a, b, length=length, travel_time=length / speed_mps, highway=highway,
               lanes=str(lanes), oneway=True)


def make_sim(g, origins, dests, depart=None, **kwargs):
    net = sim.Network(g, dt=DT)
    ids = {n: i for i, n in enumerate(net.node_ids)}
    origins = np.array([ids[o] for o in origins])
    destinations = np.zeros(net.n_nodes, dtype=bool)
    destinations[[ids[d] for d in dests]] = True
    if depart is None:
        depart = np.zeros(len(origins))
    scenario = sim.Scenario(origins, np.asarray(depart, dtype=float), destinations)
    return sim.Sim(net, scenario, dt=DT, **kwargs), net


def edge_id(net, a, b):
    ids = {n: i for i, n in enumerate(net.node_ids)}
    return int(np.flatnonzero((net.u == ids[a]) & (net.v == ids[b]))[0])


def run(s, max_steps=10_000, every=None):
    for _ in range(max_steps):
        if s.done():
            return
        s.step()
        if every:
            every(s)
    raise AssertionError("sim did not finish")


@pytest.fixture
def bridge_town():
    # Two neighborhoods (a, b) funnel onto a one-lane bridge (x -> y); a long detour (x -> d -> y) exists.
    g = nx.MultiDiGraph()
    for n, xy in {"a": (0, 1), "b": (0, -1), "x": (1, 0), "y": (2, 0), "d": (1.5, 3), "safe": (3, 0)}.items():
        g.add_node(n, x=xy[0], y=xy[1])
    road(g, "a", "x", length=200, lanes=2)
    road(g, "b", "x", length=200, lanes=2)
    road(g, "x", "y", length=100, lanes=1)
    road(g, "x", "d", length=2000, lanes=2)
    road(g, "d", "y", length=2000, lanes=2)
    road(g, "y", "safe", length=500, lanes=3, highway="primary")
    return g


def test_conservation_every_step(bridge_town):
    s, _ = make_sim(bridge_town, ["a"] * 150 + ["b"] * 150, ["safe"], depart=np.linspace(0, 600, 300))

    def check(s):
        assert sum(s.counts().values()) == 300
        assert s.occupancy.sum() == sum(len(q) for q in s.queues)

    run(s, every=check)
    assert s.counts()["evacuated"] == 300


def test_bridge_discharge_matches_capacity(bridge_town):
    s, net = make_sim(bridge_town, ["a"] * 400 + ["b"] * 400, ["safe"], reroute_every_s=1e9)
    bridge = edge_id(net, "x", "y")
    feeder = edge_id(net, "a", "x")

    crossed = 0
    for _ in range(int(1800 / DT)):
        in_flight = {car for car, _ in s.queues[bridge]}
        s.step()
        crossed += len(in_flight - {car for car, _ in s.queues[bridge]})

    # 900 veh/h/lane on one lane over 30 minutes, minus the warmup for the first car to cross.
    expected = 900 * 0.5
    assert expected * 0.85 <= crossed <= expected * 1.01
    assert s.occupancy[feeder] > 0, "a queue should be backed up upstream of the bridge"


def test_spillback_blocks_upstream():
    g = nx.MultiDiGraph()
    for n, x in {"o": 0, "m": 1, "k": 2, "safe": 3}.items():
        g.add_node(n, x=x, y=0)
    road(g, "o", "m", length=300)
    road(g, "m", "k", length=15)       # storage of 2 cars
    road(g, "k", "safe", length=100)
    s, net = make_sim(g, ["o"] * 30, ["safe"], reroute_every_s=1e9)
    short = edge_id(net, "m", "k")
    exit_edge = edge_id(net, "k", "safe")
    net.closed[exit_edge] = True  # downstream is jammed but still routed through: the tree was built before closing

    for _ in range(200):
        s.step()
    assert s.occupancy[short] == net.storage_cap[short] == 2
    assert s.occupancy[edge_id(net, "o", "m")] > 0
    assert s.counts()["evacuated"] == 0


def test_closing_bridge_reroutes_everyone(bridge_town):
    s, net = make_sim(bridge_town, ["a"] * 100 + ["b"] * 100, ["safe"])
    bridge = edge_id(net, "x", "y")
    s.set_closed(bridge, True)

    used_bridge = []
    run(s, every=lambda s: used_bridge.append(s.occupancy[bridge]))
    assert s.counts() == {"waiting": 0, "on_road": 0, "evacuated": 200, "stranded": 0}
    assert max(used_bridge) == 0


def test_mid_run_closure_reroutes_cars_already_driving(bridge_town):
    s, net = make_sim(bridge_town, ["a"] * 100, ["safe"], adopt_fraction=0.0)
    for _ in range(3):
        s.step()
    s.set_closed(edge_id(net, "x", "y"), True)
    run(s)
    # adopt_fraction=0 means only the dead-plan fallback can move these cars onto the detour.
    assert s.counts()["evacuated"] == 100


def test_no_alternative_strands_cars():
    g = nx.MultiDiGraph()
    for n, x in {"o": 0, "x": 1, "safe": 2}.items():
        g.add_node(n, x=x, y=0)
    road(g, "o", "x")
    road(g, "x", "safe")
    s, net = make_sim(g, ["o"] * 10, ["safe"])
    s.set_closed(edge_id(net, "x", "safe"), True)
    run(s)
    assert s.counts() == {"waiting": 0, "on_road": 0, "evacuated": 0, "stranded": 10}


def test_congestion_shifts_traffic_to_detour(bridge_town):
    s, net = make_sim(bridge_town, ["a"] * 400 + ["b"] * 400, ["safe"], reroute_every_s=60, adopt_fraction=1.0)
    detour = edge_id(net, "x", "d")
    seen = []
    run(s, every=lambda s: seen.append(s.occupancy[detour]))
    assert max(seen) > 0, "once the bridge queue costs more than the detour, some cars should take it"


def test_delay_is_charged_to_the_bridge_not_the_roads_queued_behind_it(bridge_town):
    s, net = make_sim(bridge_town, ["a"] * 400 + ["b"] * 400, ["safe"], reroute_every_s=1e9)
    run(s)
    bridge = edge_id(net, "x", "y")
    assert s.delay_s.argmax() == bridge
    assert s.delay_s[edge_id(net, "a", "x")] < s.delay_s[bridge] * 0.1


def test_trip_times_never_beat_free_flow(bridge_town):
    s, _ = make_sim(bridge_town, ["a"] * 300, ["safe"], depart=np.linspace(0, 300, 300))
    run(s)
    trip = s.arrive_t - s.scenario.depart
    assert np.all(np.isfinite(trip))
    assert np.all(trip >= s.free_trip - DT)
    stats = s.trip_stats()
    assert stats["p90_min"] >= stats["median_min"] > 0
    assert stats["mean_delay_min"] > 0


def test_planned_flow_and_closure_impact_follow_routes(bridge_town):
    s, net = make_sim(bridge_town, ["a"] * 120 + ["b"] * 80, ["safe"])
    flow = s.planned_flow()
    assert flow[edge_id(net, "x", "y")] == 200
    assert flow[edge_id(net, "a", "x")] == 120
    assert flow[edge_id(net, "x", "d")] == 0

    closing = np.zeros(net.n_edges, dtype=bool)
    closing[edge_id(net, "x", "d")] = True
    assert s.cars_affected(closing) == 0
    closing[edge_id(net, "x", "y")] = True
    assert s.cars_affected(closing) == 200


def test_stranded_cars_record_where_they_got_stuck():
    g = nx.MultiDiGraph()
    for n, x in {"o": 0, "x": 1, "safe": 2}.items():
        g.add_node(n, x=x, y=0)
    road(g, "o", "x")
    road(g, "x", "safe")
    s, net = make_sim(g, ["o"] * 5, ["safe"])
    for _ in range(3):
        s.step()
    s.set_closed(edge_id(net, "x", "safe"), True)
    run(s)
    ids = {n: i for i, n in enumerate(net.node_ids)}
    assert set(s.stranded_at[s.state == sim.STRANDED]) <= {ids["o"], ids["x"]}
    assert (s.stranded_at[s.state == sim.STRANDED] >= 0).all()


def test_scenario_places_each_areas_cars_on_its_own_streets():
    from shapely.geometry import box
    g = nx.MultiDiGraph()
    coords = {"h1": (0, 0), "h2": (1, 0), "h3": (10, 0), "arterial": (5, 5)}
    for n, (x, y) in coords.items():
        g.add_node(n, x=x, y=y)
    road(g, "h1", "arterial", length=100)
    road(g, "h2", "arterial", length=300)
    road(g, "h3", "arterial", length=100)
    road(g, "arterial", "h1", length=100, highway="primary")
    net = sim.Network(g, dt=DT)
    ids = {n: i for i, n in enumerate(net.node_ids)}

    west = box(-0.5, -0.5, 1.5, 0.5)       # contains h1 and h2
    sliver = box(10.1, 0.1, 10.2, 0.2)     # contains no intersection; the nearest is h3
    by_arterial = box(4.5, 4.5, 5.5, 5.5)  # only intersection is the arterial, which already counts as safe
    flood = [box(-1, -1, 11, 1)]
    scenario = sim.build_scenario(net, flood, box(-100, -100, 100, 100), [west, sliver, by_arterial],
                                  [400, 10, 20], [sim.FLOOD_ZONE, sim.FLOOD_ZONE, sim.SHADOW], departure_peak_s=300)

    counts = np.bincount(scenario.origins, minlength=net.n_nodes)
    assert counts.sum() == 430
    # h2 has three times h1's residential street, so it gets three times west's cars, plus the 20 from the
    # arterial-side area, whose only intersection already counts as safe.
    assert counts[ids["h1"]] == 100 and counts[ids["h2"]] == 300 + 20
    assert counts[ids["h3"]] == 10
    assert counts[ids["arterial"]] == 0, "nobody starts on a node that counts as safe"
    assert scenario.destinations[ids["arterial"]] and not scenario.destinations[ids["h1"]]
    assert (scenario.group == sim.SHADOW).sum() == 20
    assert np.all(np.diff(scenario.depart) >= 0)


def test_departure_curve_matches_its_peak():
    peak = 25 * 60
    times = sim.departure_times(10_000, peak)
    assert np.median(times) == pytest.approx(peak * np.sqrt(2 * np.log(2)), rel=0.01)
    assert np.percentile(times, 95) == pytest.approx(peak * 2.448, rel=0.01)
    counts, edges = np.histogram(times, bins=60)
    assert edges[counts.argmax()] == pytest.approx(peak, rel=0.1)
