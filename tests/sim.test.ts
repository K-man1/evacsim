import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildScenario, departureTimes, quantile, Sim, EVACUATED, FLOOD_ZONE, SHADOW, STRANDED, type Network,
} from "../src/sim.ts";

const DT = 5;
// Mirrors sim.Network in Python, which prepare.py runs before exporting flow_vph and storage_cap.
const LANE_FLOW: Record<string, number> = { primary: 1800, residential: 900 };

type Road = { from: string; to: string; length?: number; speedMps?: number; highway?: string; lanes?: number };

function makeSim(roads: Road[], origins: string[], dests: string[], depart?: number[], opts = {}) {
  const ids = new Map<string, number>();
  const id = (n: string) => ids.get(n) ?? ids.set(n, ids.size).get(n)!;
  for (const r of roads) { id(r.from); id(r.to); }
  const edges = roads.map(({ from, to, length = 100, speedMps = 10, highway = "residential", lanes = 1 }) => ({
    u: id(from), v: id(to), freeTime: length / speedMps, flowVph: lanes * LANE_FLOW[highway],
    storage: Math.max(1, Math.floor((lanes * length) / 7.5)),
  }));
  const net: Network = {
    nNodes: ids.size, nEdges: edges.length,
    u: Int32Array.from(edges, (e) => e.u), v: Int32Array.from(edges, (e) => e.v),
    freeTime: Float64Array.from(edges, (e) => e.freeTime), flowVph: Float64Array.from(edges, (e) => e.flowVph),
    storageCap: Int32Array.from(edges, (e) => e.storage), closed: new Uint8Array(edges.length),
  };
  const destinations = new Uint8Array(net.nNodes);
  for (const d of dests) destinations[id(d)] = 1;
  const scenario = {
    origins: Int32Array.from(origins, id),
    depart: Float64Array.from(depart ?? origins.map(() => 0)),
    destinations,
    group: new Int8Array(origins.length),
  };
  const edgeId = (a: string, b: string) => edges.findIndex((e) => e.u === id(a) && e.v === id(b));
  return { s: new Sim(net, scenario, { dt: DT, ...opts }), net, edgeId, id };
}

function run(s: Sim, every?: (s: Sim) => void, maxSteps = 10_000) {
  for (let i = 0; i < maxSteps; i++) {
    if (s.done()) return;
    s.step();
    every?.(s);
  }
  throw new Error("sim did not finish");
}

const close = (s: Sim, edge: number) => { s.net.closed[edge] = 1; s.reroute(); };
const repeat = (n: string, k: number) => Array<string>(k).fill(n);
const linspace = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));

// Two neighborhoods (a, b) funnel onto a one-lane bridge (x -> y); a long detour (x -> d -> y) exists.
const bridgeTown: Road[] = [
  { from: "a", to: "x", length: 200, lanes: 2 },
  { from: "b", to: "x", length: 200, lanes: 2 },
  { from: "x", to: "y", length: 100, lanes: 1 },
  { from: "x", to: "d", length: 2000, lanes: 2 },
  { from: "d", to: "y", length: 2000, lanes: 2 },
  { from: "y", to: "safe", length: 500, lanes: 3, highway: "primary" },
];

function queueLength(s: Sim, edge: number) {
  let n = 0;
  for (let c = s.head[edge]; c >= 0; c = s.nextInQueue[c]) n++;
  return n;
}

test("cars are conserved every step", () => {
  const { s, net } = makeSim(bridgeTown, [...repeat("a", 150), ...repeat("b", 150)], ["safe"], linspace(0, 600, 300));
  run(s, (s) => {
    const c = s.counts();
    assert.equal(c.waiting + c.on_road + c.evacuated + c.stranded, 300);
    for (let e = 0; e < net.nEdges; e++) assert.equal(s.occupancy[e], queueLength(s, e));
  });
  assert.equal(s.counts().evacuated, 300);
});

test("bridge discharge matches its capacity", () => {
  const { s, edgeId } = makeSim(bridgeTown, [...repeat("a", 400), ...repeat("b", 400)], ["safe"], undefined,
    { rerouteEveryS: 1e9 });
  const bridge = edgeId("x", "y");
  const onBridge = () => {
    const cars = new Set<number>();
    for (let c = s.head[bridge]; c >= 0; c = s.nextInQueue[c]) cars.add(c);
    return cars;
  };
  let crossed = 0;
  for (let i = 0; i < 1800 / DT; i++) {
    const before = onBridge();
    s.step();
    const after = onBridge();
    for (const c of before) if (!after.has(c)) crossed++;
  }
  // 900 veh/h/lane on one lane over 30 minutes, minus the warmup for the first car to cross.
  const expected = 900 * 0.5;
  assert.ok(crossed >= expected * 0.85 && crossed <= expected * 1.01, `crossed ${crossed}`);
  assert.ok(s.occupancy[edgeId("a", "x")] > 0, "a queue should be backed up upstream of the bridge");
});

test("spillback blocks upstream roads", () => {
  const { s, net, edgeId } = makeSim([
    { from: "o", to: "m", length: 300 },
    { from: "m", to: "k", length: 15 }, // storage of 2 cars
    { from: "k", to: "safe", length: 100 },
  ], repeat("o", 30), ["safe"], undefined, { rerouteEveryS: 1e9 });
  const short = edgeId("m", "k");
  // Downstream is jammed but still routed through: the tree was built before closing.
  net.closed[edgeId("k", "safe")] = 1;
  for (let i = 0; i < 200; i++) s.step();
  assert.equal(s.occupancy[short], 2);
  assert.equal(net.storageCap[short], 2);
  assert.ok(s.occupancy[edgeId("o", "m")] > 0);
  assert.equal(s.counts().evacuated, 0);
});

test("closing the bridge reroutes everyone", () => {
  const { s, edgeId } = makeSim(bridgeTown, [...repeat("a", 100), ...repeat("b", 100)], ["safe"]);
  const bridge = edgeId("x", "y");
  close(s, bridge);
  let maxOnBridge = 0;
  run(s, (s) => { maxOnBridge = Math.max(maxOnBridge, s.occupancy[bridge]); });
  assert.deepEqual(s.counts(), { waiting: 0, on_road: 0, evacuated: 200, stranded: 0 });
  assert.equal(maxOnBridge, 0);
});

test("a mid-run closure reroutes cars already driving", () => {
  const { s, edgeId } = makeSim(bridgeTown, repeat("a", 100), ["safe"], undefined, { adoptFraction: 0 });
  for (let i = 0; i < 3; i++) s.step();
  close(s, edgeId("x", "y"));
  run(s);
  // adoptFraction 0 means only the dead-plan fallback can move these cars onto the detour.
  assert.equal(s.counts().evacuated, 100);
});

const deadEnd = [{ from: "o", to: "x" }, { from: "x", to: "safe" }];

test("no alternative strands cars", () => {
  const { s, edgeId } = makeSim(deadEnd, repeat("o", 10), ["safe"]);
  close(s, edgeId("x", "safe"));
  run(s);
  assert.deepEqual(s.counts(), { waiting: 0, on_road: 0, evacuated: 0, stranded: 10 });
});

test("stranded cars record where they got stuck", () => {
  const { s, edgeId, id } = makeSim(deadEnd, repeat("o", 5), ["safe"]);
  for (let i = 0; i < 3; i++) s.step();
  close(s, edgeId("x", "safe"));
  run(s);
  for (let car = 0; car < 5; car++) {
    if (s.state[car] === STRANDED) assert.ok([id("o"), id("x")].includes(s.strandedAt[car]));
  }
  assert.ok(s.counts().stranded > 0);
});

test("congestion shifts traffic to the detour", () => {
  const { s, edgeId } = makeSim(bridgeTown, [...repeat("a", 400), ...repeat("b", 400)], ["safe"], undefined,
    { rerouteEveryS: 60, adoptFraction: 1 });
  const detour = edgeId("x", "d");
  let maxOnDetour = 0;
  run(s, (s) => { maxOnDetour = Math.max(maxOnDetour, s.occupancy[detour]); });
  assert.ok(maxOnDetour > 0, "once the bridge queue costs more than the detour, some cars should take it");
});

test("delay is charged to the bridge, not the roads queued behind it", () => {
  const { s, edgeId } = makeSim(bridgeTown, [...repeat("a", 400), ...repeat("b", 400)], ["safe"], undefined,
    { rerouteEveryS: 1e9 });
  run(s);
  const bridge = edgeId("x", "y");
  const worst = s.delayS.indexOf(Math.max(...s.delayS));
  assert.equal(worst, bridge);
  assert.ok(s.delayS[edgeId("a", "x")] < s.delayS[bridge] * 0.1);
});

test("trip times never beat free flow", () => {
  const { s } = makeSim(bridgeTown, repeat("a", 300), ["safe"], linspace(0, 300, 300));
  run(s);
  for (let car = 0; car < 300; car++) {
    assert.equal(s.state[car], EVACUATED);
    assert.ok(s.arriveT[car] - s.scenario.depart[car] >= s.freeTrip[car] - DT);
  }
  const stats = s.tripStats();
  assert.ok(stats.p90_min! >= stats.median_min! && stats.median_min! > 0);
  assert.ok(stats.mean_delay_min! > 0);
});

test("planned flow and closure impact follow routes", () => {
  const { s, net, edgeId } = makeSim(bridgeTown, [...repeat("a", 120), ...repeat("b", 80)], ["safe"]);
  const flow = s.plannedFlow();
  assert.equal(flow[edgeId("x", "y")], 200);
  assert.equal(flow[edgeId("a", "x")], 120);
  assert.equal(flow[edgeId("x", "d")], 0);

  const closing = new Uint8Array(net.nEdges);
  closing[edgeId("x", "d")] = 1;
  assert.equal(s.carsAffected(closing), 0);
  closing[edgeId("x", "y")] = 1;
  assert.equal(s.carsAffected(closing), 200);
});

test("scenario rounding gives every node its expected cars", () => {
  const flood = Float64Array.from([100.4, 299.6, 0, 10]);
  const shadow = Float64Array.from([0, 20, 0, 0]);
  const dests = Uint8Array.from([0, 0, 1, 0]);
  const sc = buildScenario(flood, shadow, dests, 100, 100, "short");
  const counts = [0, 0, 0, 0];
  for (const o of sc.origins) counts[o]++;
  assert.deepEqual(counts, [100, 300 + 20, 0, 10]);
  assert.equal(sc.group.filter((g) => g === SHADOW).length, 20);
  assert.equal(sc.group.filter((g) => g === FLOOD_ZONE).length, 410);
  for (let i = 1; i < sc.depart.length; i++) assert.ok(sc.depart[i] >= sc.depart[i - 1]);

  const half = buildScenario(flood, shadow, dests, 50, 0, "short");
  assert.equal(half.origins.length, 205);
});

test("departure curve matches its peak", () => {
  const peak = 25 * 60;
  const times = departureTimes(10_000, peak);
  const near = (a: number, b: number, rel: number) => assert.ok(Math.abs(a - b) <= rel * b, `${a} vs ${b}`);
  near(quantile(times, 0.5), peak * Math.sqrt(2 * Math.log(2)), 0.01);
  near(quantile(times, 0.95), peak * 2.448, 0.01);
});
