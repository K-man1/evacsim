import {
  buildScenario, quantile, Sim, EVACUATED, FLOOD_ZONE, STRANDED, type Network, type Scenario, type Warning,
} from "./sim.ts";

export const DT = 5;
export const TICK_S = 0.1;
export const SPEEDS = [1, 3, 6, 12]; // sim steps per tick

export interface NetworkJson {
  arrays: Record<string, [string, number, number]>;
  n_nodes: number;
  n_edges: number;
  n_segs: number;
  paths: number[][][];
  classes: string[];
  names: string[];
  flags: number[];
  storage: number[];
  town: number[];
  towns: string[];
  bounds: [number, number, number, number];
  demand: Record<"people" | "households" | "no_vehicle" | "no_vehicle_people", number[]>;
  shadow_households: number;
}

const VIEWS = { float64: Float64Array, int32: Int32Array, uint8: Uint8Array } as const;

function arrays(meta: NetworkJson, bin: ArrayBuffer) {
  const view = <K extends keyof typeof VIEWS>(name: string, dtype: K): InstanceType<(typeof VIEWS)[K]> => {
    const [actual, offset, length] = meta.arrays[name];
    if (actual !== dtype) throw new Error(`network.bin: ${name} is ${actual}, expected ${dtype}`);
    return new VIEWS[dtype](bin, offset, length) as InstanceType<(typeof VIEWS)[K]>;
  };
  return {
    nodeX: view("node_x", "float64"), nodeY: view("node_y", "float64"), nodeTown: view("node_town", "int32"),
    destination: view("destination", "uint8"),
    expectedFlood: view("expected_flood", "float64"), expectedShadow: view("expected_shadow", "float64"),
    u: view("edge_u", "int32"), v: view("edge_v", "int32"), freeTime: view("free_time", "float64"),
    flowVph: view("flow_vph", "float64"), storageCap: view("storage_cap", "int32"),
    segOfEdge: view("seg_of_edge", "int32"),
    segMidX: view("seg_mid_x", "float64"), segMidY: view("seg_mid_y", "float64"),
    segFloodedBridge: view("seg_flooded_bridge", "uint8"),
  };
}

type History = [number, number][];
const round = (x: number, digits: number) => Math.round(x * 10 ** digits) / 10 ** digits;
const minutes = (s: number) => round(s / 60, 1);

/** Everything the UI drives: the network, the current run, closures, and the run before this one. */
export class World {
  meta: NetworkJson;
  a: ReturnType<typeof arrays>;
  net: Network;
  nSegs: number;
  segStart: Int32Array;
  segEdges: Int32Array;

  rate = 100;
  shadow = 20;
  warning: Warning = "short";
  scenario!: Scenario;
  floodCar!: Uint8Array;
  floodTotal = 0;
  carTown!: Int32Array;
  sim!: Sim;

  running = false;
  speed = SPEEDS[2];
  runId = 0;
  // Evacuation curves for this run and the last, so the comparison chart survives a reset.
  history: History = [[0, 0]];
  previous: { total: number; done: boolean; points: History; summary: ReturnType<World["summary"]> } | null = null;
  // Closures in force while this run was live; edits made after it finishes belong to the next run.
  runClosed = 0;

  constructor(meta: NetworkJson, bin: ArrayBuffer) {
    this.meta = meta;
    this.a = arrays(meta, bin);
    const { u, v, freeTime, flowVph, storageCap, segOfEdge } = this.a;
    this.net = {
      nNodes: meta.n_nodes, nEdges: meta.n_edges, u, v, freeTime, flowVph, storageCap,
      closed: new Uint8Array(meta.n_edges),
    };
    // The directed edges that make up each drawn road, grouped by road.
    this.nSegs = meta.n_segs;
    this.segStart = new Int32Array(this.nSegs + 1);
    for (const s of segOfEdge) this.segStart[s + 1]++;
    for (let s = 0; s < this.nSegs; s++) this.segStart[s + 1] += this.segStart[s];
    this.segEdges = new Int32Array(meta.n_edges);
    const fill = this.segStart.slice(0, this.nSegs);
    segOfEdge.forEach((s, e) => { this.segEdges[fill[s]++] = e; });

    this.setScenario(this.rate, this.shadow, this.warning);
    this.sim = new Sim(this.net, this.scenario, { dt: DT });
  }

  /** Rebuild demand: percent of flood-zone households leaving, percent of nearby households joining them
   * (shadow evacuation), and how much warning everyone had. */
  setScenario(rate: number, shadow: number, warning: Warning) {
    this.rate = rate;
    this.shadow = shadow;
    this.warning = warning;
    const { expectedFlood, expectedShadow, destination, nodeTown } = this.a;
    this.scenario = buildScenario(expectedFlood, expectedShadow, destination, rate, shadow, warning);
    this.floodCar = Uint8Array.from(this.scenario.group, (g) => Number(g === FLOOD_ZONE));
    this.floodTotal = this.floodCar.reduce((a, b) => a + b, 0);
    this.carTown = Int32Array.from(this.scenario.origins, (o) => nodeTown[o]);
  }

  get nCars() {
    return this.scenario.origins.length;
  }

  floodOut(): number {
    let n = 0;
    for (let car = 0; car < this.nCars; car++) if (this.floodCar[car] && this.sim.state[car] === EVACUATED) n++;
    return n;
  }

  closedSegments(): number[] {
    const out: number[] = [];
    for (let s = 0; s < this.nSegs; s++) {
      for (let k = this.segStart[s]; k < this.segStart[s + 1]; k++) {
        if (this.net.closed[this.segEdges[k]]) {
          out.push(s);
          break;
        }
      }
    }
    return out;
  }

  snapshot() {
    const s = this.sim;
    const { segOfEdge } = this.a;
    const queued = new Map<number, number>();
    const load = new Map<number, number>();
    for (let e = 0; e < this.net.nEdges; e++) {
      const occ = s.occupancy[e];
      if (!occ) continue;
      const seg = segOfEdge[e];
      queued.set(seg, (queued.get(seg) ?? 0) + occ);
      load.set(seg, Math.max(load.get(seg) ?? 0, Math.min(occ / this.net.storageCap[e], 1)));
    }
    const segs = [...queued.keys()].sort((x, y) => x - y);
    return {
      run: this.runId,
      t: s.t,
      counts: s.counts(),
      // Progress and outcomes are about flood-zone residents; shadow cars are extra load on their roads.
      total: this.floodTotal,
      flood_out: this.floodOut(),
      cars: this.nCars,
      done: s.done(),
      running: this.running,
      speed: this.speed,
      segs,
      load: segs.map((g) => round(load.get(g)!, 3)),
      queued: segs.map((g) => queued.get(g)!),
      closed: this.closedSegments(),
    };
  }

  /** Record the evacuation curve; call after anything that changes the run. */
  publish() {
    if (this.sim.t > this.history[this.history.length - 1][0]) this.history.push([this.sim.t, this.floodOut()]);
  }

  tick() {
    if (!this.running) return false;
    for (let i = 0; i < this.speed; i++) {
      this.sim.step();
      if (this.sim.done()) {
        this.running = false;
        break;
      }
    }
    this.publish();
    return true;
  }

  demand() {
    const d = this.meta.demand;
    const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0));
    return {
      people: sum(d.people),
      households: sum(d.households),
      no_vehicle: sum(d.no_vehicle),
      no_vehicle_people: sum(d.no_vehicle_people),
      cars: this.floodTotal,
      rate: this.rate,
      shadow: this.shadow,
      shadow_households: Math.round(this.meta.shadow_households),
      shadow_cars: this.nCars - this.floodTotal,
      warning: this.warning,
    };
  }

  reset(rate?: number, shadow?: number, warning?: Warning) {
    if (this.history.length > 2) {
      this.previous = { total: this.floodTotal, done: this.sim.done(), points: this.history, summary: this.summary() };
    }
    const next: [number, number, Warning] = [rate ?? this.rate, shadow ?? this.shadow, warning ?? this.warning];
    if (next[0] !== this.rate || next[1] !== this.shadow || next[2] !== this.warning) this.setScenario(...next);
    // Closures are part of the scenario a planner is testing, so they survive a reset.
    this.sim = new Sim(this.net, this.scenario, { dt: DT });
    this.history = [[0, 0]];
    this.runClosed = this.closedSegments().length;
    this.runId++;
    this.running = false;
  }

  setSegments(segs: number[], closed: boolean) {
    const changing = new Uint8Array(this.net.nEdges);
    const changedSegs = new Set<number>();
    for (const s of segs) {
      for (let k = this.segStart[s]; k < this.segStart[s + 1]; k++) {
        const e = this.segEdges[k];
        if (Boolean(this.net.closed[e]) !== closed) {
          changing[e] = 1;
          changedSegs.add(s);
        }
      }
    }
    // Measured on the routes in force before the change: these are the drivers who must find another way.
    const affected = closed ? this.sim.carsAffected(changing) : 0;
    for (let e = 0; e < this.net.nEdges; e++) if (changing[e]) this.net.closed[e] = Number(closed);
    this.sim.reroute();
    if (!this.sim.done()) this.runClosed = this.closedSegments().length;
    return { changed: changedSegs.size, affected };
  }

  floodedBridges(): number[] {
    const out: number[] = [];
    this.a.segFloodedBridge.forEach((f, s) => { if (f) out.push(s); });
    return out;
  }

  play() {
    if (this.sim.done()) this.reset();
    this.running = true;
  }

  perSeg(perEdge: ArrayLike<number>): Float64Array {
    const out = new Float64Array(this.nSegs);
    for (let e = 0; e < this.net.nEdges; e++) out[this.a.segOfEdge[e]] += perEdge[e];
    return out;
  }

  timeTo(fraction: number, history: History, total: number): number | null {
    for (const [t, evacuated] of history) if (evacuated >= fraction * total) return minutes(t);
    return null;
  }

  summary() {
    const s = this.sim;
    let out = 0, stranded = 0, strandedAll = 0, resolved = 0, lastOut = -Infinity;
    for (let car = 0; car < this.nCars; car++) {
      const st = s.state[car];
      if (st === STRANDED) strandedAll++;
      if (!this.floodCar[car]) continue;
      if (st === EVACUATED) {
        out++;
        resolved++;
        lastOut = Math.max(lastOut, s.arriveT[car]);
      } else if (st === STRANDED) {
        stranded++;
        resolved++;
      }
    }
    const segDelay = this.perSeg(s.delayS);
    let worst = 0;
    for (let g = 1; g < this.nSegs; g++) if (segDelay[g] > segDelay[worst]) worst = g;
    const trip = s.tripStats(FLOOD_ZONE);
    const r2 = (x: number | null) => (x == null ? null : round(x, 2));
    return {
      cars: this.floodTotal,
      shadow_cars: this.nCars - this.floodTotal,
      rate: this.rate,
      shadow: this.shadow,
      warning: this.warning,
      closed: this.runClosed,
      done: s.done(),
      // Cleared = the last flood-zone resident who could get out did; shadow stragglers don't count.
      cleared_min: resolved === this.floodTotal && out ? minutes(lastOut) : null,
      t50_min: this.timeTo(0.5, this.history, this.floodTotal),
      t90_min: this.timeTo(0.9, this.history, this.floodTotal),
      evacuated: out,
      stranded,
      stranded_all: strandedAll,
      median_min: r2(trip.median_min),
      p90_min: r2(trip.p90_min),
      mean_delay_min: r2(trip.mean_delay_min),
      delay_veh_h: r2(trip.delay_veh_h),
      worst_road: segDelay[worst] > 0 ? this.meta.names[worst] || "Unnamed road" : null,
    };
  }

  stats() {
    const s = this.sim;
    const d = this.meta.demand;
    // Town rows describe flood-zone residents; shadow cars only show up as load on the roads.
    // Bucket nTowns - 1 is "outside every NJ-12 town"; nTowns collects shadow cars.
    const nTowns = this.meta.towns.length;
    const cars = new Int32Array(nTowns + 1), out = new Int32Array(nTowns + 1), stuck = new Int32Array(nTowns + 1);
    const last = new Float64Array(nTowns + 1);
    const trips: number[][] = Array.from({ length: nTowns }, () => []);
    const delays: number[][] = Array.from({ length: nTowns }, () => []);
    for (let car = 0; car < this.nCars; car++) {
      const k = this.floodCar[car] ? this.carTown[car] : nTowns;
      cars[k]++;
      if (s.state[car] === EVACUATED) {
        out[k]++;
        last[k] = Math.max(last[k], s.arriveT[car]);
        if (k < nTowns) {
          const trip = s.arriveT[car] - this.scenario.depart[car];
          trips[k].push(trip);
          const delay = trip - s.freeTrip[car];
          if (Number.isFinite(delay)) delays[k].push(delay);
        }
      } else if (s.state[car] === STRANDED) {
        stuck[k]++;
      }
    }
    const towns = [];
    for (let k = 0; k < nTowns; k++) {
      if (!(cars[k] > 0 || d.households[k] >= 0.5)) continue;
      const remaining = cars[k] - out[k] - stuck[k];
      const sorted = trips[k].sort((x, y) => x - y);
      towns.push({
        town: k, cars: cars[k], evacuated: out[k], stranded: stuck[k],
        people: Math.round(d.people[k]), households: Math.round(d.households[k]),
        no_vehicle: Math.round(d.no_vehicle[k]), no_vehicle_people: Math.round(d.no_vehicle_people[k]),
        remaining,
        cleared_min: remaining === 0 && out[k] ? minutes(last[k]) : null,
        median_min: sorted.length ? minutes(quantile(sorted, 0.5)) : null,
        delay_min: delays[k].length ? minutes(delays[k].reduce((x, y) => x + y, 0) / delays[k].length) : null,
      });
    }

    const segDelay = this.perSeg(s.delayS).map((x) => x / 60); // vehicle-minutes
    const segFlow = this.perSeg(s.plannedFlow());
    const segQueue = this.perSeg(s.occupancy);
    const closed = new Set(this.closedSegments());
    const ranked = Array.from(segDelay.keys()).sort((x, y) => segDelay[y] - segDelay[x]).slice(0, 12);
    const bottlenecks = ranked.filter((g) => segDelay[g] > 0).map((g) => ({
      seg: g, delay_veh_h: round(segDelay[g] / 60, 1), queued: segQueue[g], flow: segFlow[g],
      town: this.meta.town[g], at: [round(this.a.segMidX[g], 5), round(this.a.segMidY[g], 5)], closed: closed.has(g),
    }));

    const stuckAt = new Map<number, number>();
    for (let car = 0; car < this.nCars; car++) {
      if (s.state[car] === STRANDED) stuckAt.set(s.strandedAt[car], (stuckAt.get(s.strandedAt[car]) ?? 0) + 1);
    }
    const stranded = [...stuckAt].sort(([x], [y]) => x - y).map(([n, count]) => [
      round(this.a.nodeX[n], 5), round(this.a.nodeY[n], 5), count, this.a.nodeTown[n],
    ]);

    const delayed: number[] = [], routed: number[] = [];
    for (let g = 0; g < this.nSegs; g++) {
      if (segDelay[g] >= 0.5) delayed.push(g);
      if (segFlow[g] > 0) routed.push(g);
    }
    return {
      run: this.runId,
      t: s.t,
      summary: this.summary(),
      demand: this.demand(),
      previous: this.previous?.summary ?? null,
      towns,
      bottlenecks,
      stranded,
      delay: { segs: delayed, veh_min: delayed.map((g) => round(segDelay[g], 1)) },
      flow: { segs: routed, cars: routed.map((g) => Math.round(segFlow[g])) },
    };
  }
}

export type Snapshot = ReturnType<World["snapshot"]>;
export type Stats = ReturnType<World["stats"]>;
