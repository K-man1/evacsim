export const WAITING = 0, ON_ROAD = 1, EVACUATED = 2, STRANDED = 3;
export const ARRIVE = -2;
export const NO_ROUTE = -1;
export const FLOOD_ZONE = 0, SHADOW = 1;

// Departure curves, as the Rayleigh scale in seconds: the minute departures peak. 95% have left by 2.45x that.
// Rayleigh-shaped mobilization curves are a common choice in evacuation modeling: a slow start while people
// hear the order and pack, a peak, then a long tail of late leavers.
export const DEPARTURE_PEAK_S = {
  sudden: 10 * 60, // flash flood or overnight surge: 95% gone within ~25 min
  short: 25 * 60, // a few hours of warning: 95% gone within ~1 h
  long: 75 * 60, // day-ahead order: 95% gone within ~3 h
} as const;
export type Warning = keyof typeof DEPARTURE_PEAK_S;

export interface Network {
  nNodes: number;
  nEdges: number;
  u: Int32Array;
  v: Int32Array;
  freeTime: Float64Array;
  flowVph: Float64Array;
  storageCap: Int32Array;
  closed: Uint8Array;
}

export interface Scenario {
  origins: Int32Array;
  depart: Float64Array;
  destinations: Uint8Array;
  group: Int8Array;
}

export interface TripStats {
  median_min: number | null;
  p90_min: number | null;
  mean_delay_min: number | null;
  delay_veh_h: number;
}

// mulberry32: small, fast, and seedable, which Math.random is not.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(xs: Int32Array, random: () => number) {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = xs[i];
    xs[i] = xs[j];
    xs[j] = tmp;
  }
}

/** Evenly spaced quantiles of a Rayleigh curve, so a run's departures match the curve exactly. */
export function departureTimes(n: number, peakS: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = peakS * Math.sqrt(-2 * Math.log1p(-(i + 0.5) / n));
  return out;
}

/**
 * Cars per node from the exported 100% weights. `rate` and `shadow` are percents; the weights are linear in
 * households, so scaling them is the same as rebuilding demand at that evacuation rate.
 */
export function buildScenario(expectedFlood: Float64Array, expectedShadow: Float64Array, destinations: Uint8Array,
  rate: number, shadow: number, warning: Warning, seed = 0): Scenario {
  const origins: number[] = [];
  const group: number[] = [];
  for (const [g, weights, share] of [[FLOOD_ZONE, expectedFlood, rate / 100], [SHADOW, expectedShadow, shadow / 100]] as const) {
    const expected = Array.from(weights, (w) => w * share);
    const counts = expected.map(Math.floor);
    const n = Math.round(expected.reduce((a, b) => a + b, 0));
    // Largest-remainder rounding: every intersection gets its expected count, not a random draw around it.
    const short = n - counts.reduce((a, b) => a + b, 0);
    const byRemainder = expected.map((_, i) => i).filter((i) => expected[i] > counts[i])
      .sort((a, b) => (counts[a] - expected[a]) - (counts[b] - expected[b]));
    for (const i of byRemainder.slice(0, short)) counts[i]++;
    counts.forEach((c, node) => { for (let k = 0; k < c; k++) origins.push(node); });
    while (group.length < origins.length) group.push(g);
  }
  if (!origins.length) throw new Error("no households to evacuate");

  // Which household leaves at which point on the curve is the one random choice left.
  const order = Int32Array.from(origins, (_, i) => i);
  shuffle(order, rng(seed));
  return {
    origins: Int32Array.from(order, (i) => origins[i]),
    depart: departureTimes(origins.length, DEPARTURE_PEAK_S[warning]),
    destinations,
    group: Int8Array.from(order, (i) => group[i]),
  };
}

/** Binary min-heap of node ids keyed by distance, with lazy deletion: stale entries are skipped on pop. */
class Heap {
  keys: Float64Array;
  nodes: Int32Array;
  size = 0;

  constructor(capacity: number) {
    this.keys = new Float64Array(capacity);
    this.nodes = new Int32Array(capacity);
  }

  push(key: number, node: number) {
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.keys[i] = this.keys[parent];
      this.nodes[i] = this.nodes[parent];
      i = parent;
    }
    this.keys[i] = key;
    this.nodes[i] = node;
  }

  pop(): number {
    const top = this.nodes[0];
    const key = this.keys[--this.size];
    const node = this.nodes[this.size];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.keys[child + 1] < this.keys[child]) child++;
      if (this.keys[child] >= key) break;
      this.keys[i] = this.keys[child];
      this.nodes[i] = this.nodes[child];
      i = child;
    }
    this.keys[i] = key;
    this.nodes[i] = node;
    return top;
  }
}

export class Sim {
  net: Network;
  scenario: Scenario;
  dt: number;
  rerouteEveryS: number;
  adoptFraction: number;
  random: () => number;
  flowCap: Float64Array;

  t = 0;
  state: Int8Array;
  treeOf: Int32Array;
  nextDeparture = 0;
  departedWaiting: number[] = [];
  edgeOfCar: Int32Array;
  arriveT: Float64Array;
  strandedAt: Int32Array;

  // Each road's queue is a linked list threaded through the cars on it; a car is on at most one road.
  head: Int32Array;
  tail: Int32Array;
  nextInQueue: Int32Array;
  exitTime: Float64Array;
  occupancy: Int32Array;
  budget: Float64Array;
  spill: Int32Array;
  // Vehicle-seconds lost per road: time cars spent past their free-flow exit, charged to the root bottleneck.
  delayS: Float64Array;
  heldBy = new Map<number, number>();
  readyWaiting = new Map<number, number>();

  freeTrip: Float64Array;
  trees = new Map<number, Int32Array>();
  latestTree = -1;
  lastReroute = 0;
  treeOrder = new Int32Array(0);

  revStart: Int32Array;
  revEdge: Int32Array;
  heap: Heap;

  constructor(net: Network, scenario: Scenario, { dt = 5, rerouteEveryS = 120, adoptFraction = 0.3, seed = 0 } = {}) {
    this.net = net;
    this.scenario = scenario;
    this.dt = dt;
    this.rerouteEveryS = rerouteEveryS;
    this.adoptFraction = adoptFraction;
    this.random = rng(seed);
    this.flowCap = net.flowVph.map((vph) => (vph * dt) / 3600);

    const n = scenario.origins.length;
    this.state = new Int8Array(n).fill(WAITING);
    this.treeOf = new Int32Array(n);
    this.edgeOfCar = new Int32Array(n).fill(-1);
    this.arriveT = new Float64Array(n).fill(NaN);
    this.strandedAt = new Int32Array(n).fill(-1);
    this.nextInQueue = new Int32Array(n).fill(-1);
    this.exitTime = new Float64Array(n);

    this.head = new Int32Array(net.nEdges).fill(-1);
    this.tail = new Int32Array(net.nEdges).fill(-1);
    this.occupancy = new Int32Array(net.nEdges);
    this.budget = new Float64Array(net.nEdges);
    this.spill = new Int32Array(net.nEdges);
    this.delayS = new Float64Array(net.nEdges);

    // Edges grouped by the node they enter, for searching backward from the destinations.
    this.revStart = new Int32Array(net.nNodes + 1);
    for (let e = 0; e < net.nEdges; e++) this.revStart[net.v[e] + 1]++;
    for (let i = 0; i < net.nNodes; i++) this.revStart[i + 1] += this.revStart[i];
    this.revEdge = new Int32Array(net.nEdges);
    const fill = this.revStart.slice(0, net.nNodes);
    for (let e = 0; e < net.nEdges; e++) this.revEdge[fill[net.v[e]]++] = e;
    this.heap = new Heap(net.nEdges + net.nNodes);

    // The trip each car would make on an empty network with every road open; delay is measured against it.
    const { dist } = this.shortestTree(net.freeTime, new Uint8Array(net.nEdges));
    this.freeTrip = Float64Array.from(scenario.origins, (o) => dist[o]);
    this.reroute();
  }

  counts() {
    const tally = [0, 0, 0, 0];
    for (const s of this.state) tally[s]++;
    return { waiting: tally[WAITING], on_road: tally[ON_ROAD], evacuated: tally[EVACUATED], stranded: tally[STRANDED] };
  }

  edgeWeights(): Float64Array {
    // Expected traversal time if you joined the queue now: free-flow time plus time for the queue to drain.
    // At a bottleneck the queue is physically stored on the upstream roads, so `spill` charges those
    // cars to the road they're waiting to enter; otherwise a jammed bridge would look free.
    const { freeTime } = this.net;
    return freeTime.map((ft, e) => ft + (this.occupancy[e] + this.spill[e]) / (this.flowCap[e] / this.dt));
  }

  /** Next edge and travel time from every node to its nearest destination, plus nodes in order of distance. */
  shortestTree(weights: Float64Array, closed: Uint8Array) {
    const { nNodes, u, v } = this.net;
    const dist = new Float64Array(nNodes).fill(Infinity);
    const nextEdge = new Int32Array(nNodes).fill(NO_ROUTE);
    const settled = new Uint8Array(nNodes);
    const order = new Int32Array(nNodes);
    let nOrdered = 0;
    const heap = this.heap;
    heap.size = 0;
    const dests = this.scenario.destinations;
    for (let n = 0; n < nNodes; n++) {
      if (dests[n]) {
        dist[n] = 0;
        nextEdge[n] = ARRIVE;
        heap.push(0, n);
      }
    }
    while (heap.size) {
      const node = heap.pop();
      if (settled[node]) continue;
      settled[node] = 1;
      if (!dests[node]) order[nOrdered++] = node;
      const d = dist[node];
      for (let k = this.revStart[node]; k < this.revStart[node + 1]; k++) {
        const e = this.revEdge[k];
        const from = u[e];
        if (closed[e] || from === v[e]) continue;
        const cand = d + Math.max(weights[e], 0.01);
        if (cand < dist[from]) {
          dist[from] = cand;
          nextEdge[from] = e;
          heap.push(cand, from);
        }
      }
    }
    return { nextEdge, dist, order: order.slice(0, nOrdered) };
  }

  reroute() {
    const { nextEdge, order } = this.shortestTree(this.edgeWeights(), this.net.closed);
    // Nodes ordered from nearest to safety outward; every node's next hop comes before it.
    this.treeOrder = order;
    this.latestTree++;
    this.trees.set(this.latestTree, nextEdge);
    this.lastReroute = this.t;

    const live = new Set([this.latestTree]);
    for (let car = 0; car < this.state.length; car++) {
      const s = this.state[car];
      if (s === WAITING || (s === ON_ROAD && this.random() < this.adoptFraction)) this.treeOf[car] = this.latestTree;
      if (s <= ON_ROAD) live.add(this.treeOf[car]);
    }
    for (const k of this.trees.keys()) if (!live.has(k)) this.trees.delete(k);
  }

  nextHop(car: number, node: number): number {
    let nxt = this.trees.get(this.treeOf[car])![node];
    if (nxt === NO_ROUTE || (nxt >= 0 && this.net.closed[nxt])) {
      // The car's plan is dead; it takes the current best plan regardless of the adoption lottery.
      this.treeOf[car] = this.latestTree;
      nxt = this.trees.get(this.latestTree)![node];
    }
    return nxt;
  }

  /** Cars not yet safe at each node: waiting at their origin, or headed for the end of the road they're on. */
  pendingAtNode(): Int32Array {
    const at = new Int32Array(this.net.nNodes);
    for (let car = 0; car < this.state.length; car++) {
      if (this.state[car] === WAITING) at[this.scenario.origins[car]]++;
      else if (this.state[car] === ON_ROAD) at[this.net.v[this.edgeOfCar[car]]]++;
    }
    return at;
  }

  /** Cars on each road now plus cars whose current best route still crosses it. */
  plannedFlow(): Float64Array {
    const nxt = this.trees.get(this.latestTree)!;
    const atNode = this.pendingAtNode();
    const flow = Float64Array.from(this.occupancy);
    for (let k = this.treeOrder.length - 1; k >= 0; k--) {
      const node = this.treeOrder[k];
      const cars = atNode[node];
      if (cars) {
        const e = nxt[node];
        flow[e] += cars;
        atNode[this.net.v[e]] += cars;
      }
    }
    return flow;
  }

  /** Cars whose current route uses each requested edge, grouped by the caller's car labels. */
  plannedGroups(edges: number[], groupOfCar: ArrayLike<number>, nGroups: number): Int32Array[] {
    const target = new Map(edges.map((edge, index) => [edge, index]));
    const groups = edges.map(() => new Int32Array(nGroups));
    const nxt = this.trees.get(this.latestTree)!;
    for (let car = 0; car < this.state.length; car++) {
      if (this.state[car] > ON_ROAD) continue;
      const group = groupOfCar[car];
      let node = this.scenario.origins[car];
      if (this.state[car] === ON_ROAD) {
        const edge = this.edgeOfCar[car];
        const index = target.get(edge);
        if (index !== undefined) groups[index][group]++;
        node = this.net.v[edge];
      }
      for (let steps = 0; steps < this.net.nNodes; steps++) {
        const edge = nxt[node];
        if (edge < 0) break;
        const index = target.get(edge);
        if (index !== undefined) groups[index][group]++;
        node = this.net.v[edge];
      }
    }
    return groups;
  }

  /** How many cars' current best routes cross any edge in the `closing` mask. */
  carsAffected(closing: Uint8Array): number {
    const nxt = this.trees.get(this.latestTree)!;
    const hits = new Uint8Array(this.net.nNodes);
    for (const node of this.treeOrder) {
      const e = nxt[node];
      hits[node] = closing[e] || hits[this.net.v[e]];
    }
    const at = this.pendingAtNode();
    let total = 0;
    for (let n = 0; n < at.length; n++) if (hits[n]) total += at[n];
    return total;
  }

  tripStats(group: number | null = null): TripStats {
    const trips: number[] = [];
    let delaySum = 0, delayN = 0;
    for (let car = 0; car < this.state.length; car++) {
      if (this.state[car] !== EVACUATED || (group !== null && this.scenario.group[car] !== group)) continue;
      const trip = this.arriveT[car] - this.scenario.depart[car];
      trips.push(trip);
      const delay = trip - this.freeTrip[car];
      if (Number.isFinite(delay)) {
        delaySum += delay;
        delayN++;
      }
    }
    trips.sort((a, b) => a - b);
    let total = 0;
    for (const d of this.delayS) total += d;
    return {
      median_min: trips.length ? quantile(trips, 0.5) / 60 : null,
      p90_min: trips.length ? quantile(trips, 0.9) / 60 : null,
      mean_delay_min: delayN ? delaySum / delayN / 60 : null,
      delay_veh_h: total / 3600,
    };
  }

  canAdvance(edge: number, exitTime: number, nxt: number): boolean {
    if (exitTime > this.t || this.budget[edge] < 1) return false;
    if (nxt === ARRIVE) return true;
    return !this.net.closed[nxt] && this.occupancy[nxt] < this.net.storageCap[nxt];
  }

  enter(car: number, edge: number) {
    this.exitTime[car] = this.t + this.net.freeTime[edge];
    this.nextInQueue[car] = -1;
    if (this.tail[edge] < 0) this.head[edge] = car;
    else this.nextInQueue[this.tail[edge]] = car;
    this.tail[edge] = car;
    this.occupancy[edge]++;
    this.state[car] = ON_ROAD;
    this.edgeOfCar[car] = edge;
  }

  popHead(edge: number) {
    const car = this.head[edge];
    this.head[edge] = this.nextInQueue[car];
    if (this.head[edge] < 0) this.tail[edge] = -1;
    this.occupancy[edge]--;
  }

  evacuate(car: number) {
    this.state[car] = EVACUATED;
    this.arriveT[car] = this.t;
    this.edgeOfCar[car] = -1;
  }

  strand(car: number, node: number) {
    this.state[car] = STRANDED;
    this.strandedAt[car] = node;
    this.edgeOfCar[car] = -1;
  }

  discharge(edge: number) {
    const node = this.net.v[edge];
    while (this.head[edge] >= 0) {
      const car = this.head[edge];
      const exitTime = this.exitTime[car];
      const nxt = this.nextHop(car, node);
      if (nxt === NO_ROUTE) {
        this.popHead(edge);
        this.strand(car, node);
        continue;
      }
      if (!this.canAdvance(edge, exitTime, nxt)) {
        if (exitTime <= this.t) {
          const downstreamFull = nxt >= 0 && this.budget[edge] >= 1;
          if (downstreamFull) this.spill[nxt] += this.occupancy[edge];
          // FIFO: every ready car behind the head is held by whatever holds the head.
          let ready = 0;
          for (let c = car; c >= 0 && this.exitTime[c] <= this.t; c = this.nextInQueue[c]) ready++;
          this.heldBy.set(edge, downstreamFull ? nxt : edge);
          this.readyWaiting.set(edge, (this.readyWaiting.get(edge) ?? 0) + ready);
        }
        break;
      }
      this.popHead(edge);
      this.budget[edge]--;
      if (nxt === ARRIVE) this.evacuate(car);
      else this.enter(car, nxt);
    }
  }

  depart() {
    const { origins, depart: times } = this.scenario;
    while (this.nextDeparture < times.length && times[this.nextDeparture] <= this.t) {
      this.departedWaiting.push(this.nextDeparture++);
    }

    // Cars whose first road is full stay in the driveway and try again next step.
    const stillWaiting: number[] = [];
    for (const car of this.departedWaiting) {
      const nxt = this.nextHop(car, origins[car]);
      if (nxt === ARRIVE) {
        this.evacuate(car);
      } else if (nxt === NO_ROUTE) {
        this.strand(car, origins[car]);
      } else if (!this.net.closed[nxt] && this.occupancy[nxt] < this.net.storageCap[nxt]) {
        this.enter(car, nxt);
      } else {
        if (!this.net.closed[nxt]) {
          this.spill[nxt]++;
          this.readyWaiting.set(nxt, (this.readyWaiting.get(nxt) ?? 0) + 1);
        }
        stillWaiting.push(car);
      }
    }
    this.departedWaiting = stillWaiting;
  }

  step() {
    this.t += this.dt;
    if (this.t - this.lastReroute >= this.rerouteEveryS) this.reroute();
    this.spill.fill(0);

    const activeList: number[] = [];
    for (let e = 0; e < this.net.nEdges; e++) {
      if (this.occupancy[e] > 0) {
        // Fractional capacity carries over, capped so an idle road can't bank a burst.
        this.budget[e] = Math.min(this.budget[e] + this.flowCap[e], this.flowCap[e] + 1);
        activeList.push(e);
      }
    }
    const active = Int32Array.from(activeList);
    shuffle(active, this.random);
    this.heldBy.clear();
    this.readyWaiting.clear();
    for (const edge of active) this.discharge(edge);
    this.depart();
    for (const [edge, ready] of this.readyWaiting) this.delayS[this.rootCause(edge)] += ready * this.dt;
  }

  /** Follow a chain of full roads downstream to the one limited by its own capacity. */
  rootCause(edge: number): number {
    const seen = new Set<number>();
    for (;;) {
      const cause = this.heldBy.get(edge) ?? edge;
      if (cause === edge || seen.has(cause)) return cause; // self-limited, or gridlocked in a loop
      seen.add(edge);
      edge = cause;
    }
  }

  done(): boolean {
    if (this.nextDeparture < this.scenario.depart.length || this.departedWaiting.length) return false;
    for (const s of this.state) if (s === ON_ROAD) return false;
    return true;
  }
}

/** numpy's default (linear) percentile on an ascending array. */
export function quantile(sorted: ArrayLike<number>, q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
