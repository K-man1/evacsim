import { PathStyleExtension } from "@deck.gl/extensions";
import type { GeoBoundingBox } from "@deck.gl/geo-layers";
import {
  BitmapLayer, Deck, FlyToInterpolator, GeoJsonLayer, PathLayer, ScatterplotLayer, TileLayer, WebMercatorViewport,
  type Color, type MapViewState, type PickingInfo,
} from "deck.gl";
import type { Feature, FeatureCollection, Position } from "geojson";

import { clickSpark, countUp } from "./bits.ts";
import type { Warning } from "./sim.ts";
import type { Command, FromWorker } from "./worker.ts";
import type { NetworkJson, RoadAction, Snapshot, State, Stats, ZonePlan } from "./world.ts";
import { staggerZones } from "./world.ts";

type Rgb = [number, number, number];
type Road = { i: number; path: [number, number][]; cls: string; name: string; flags: number; storage: number; town: number };
type Mode = "queues" | "delay" | "routes";
type Tab = "overview" | "bottlenecks" | "towns" | "compare";
type Summary = Stats["summary"];
type TownRow = Stats["towns"][number];
type Point = { t: number; pct: number };
type SavedPlan = {
  name: string;
  summary: Summary;
  rate: number;
  shadow: number;
  warning: Warning;
  zones: ZonePlan[];
  roadActions: RoadAction[];
};

function loadSavedPlans(): SavedPlan[] {
  try {
    const value = JSON.parse(localStorage.getItem("evacsim-plans") ?? "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

let savedPlans = loadSavedPlans();

const FLAG_BRIDGE = 1, FLAG_FLOODED = 2;
const ROAD_STYLE: Record<string, [Rgb, number]> = {
  motorway: [[74, 74, 74], 2.2], trunk: [[68, 68, 68], 2], primary: [[60, 60, 60], 1.8],
  secondary: [[52, 52, 52], 1.4], tertiary: [[44, 44, 44], 1.1],
};
const LOCAL_STYLE: [Rgb, number] = [[34, 34, 34], 0.8];
// Single-hue ordinal ramp validated against the dark map surface (dataviz validate_palette --ordinal).
const RAMP: Rgb[] = [[138, 58, 18], [201, 83, 29], [240, 122, 60], [255, 185, 140]];
const CRITICAL: Rgb = [208, 59, 59];
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
const minutes = (m: number | null) => (m == null ? "—" : m < 10 ? m.toFixed(1) : String(Math.round(m)));

// The simulation runs in a worker; each request is one of what used to be the Flask server's endpoints.
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let nextId = 1;
worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const msg = e.data;
  if (msg.type === "snapshot") return applySnapshot(msg.snapshot);
  const waiter = pending.get(msg.id)!;
  pending.delete(msg.id);
  if (msg.error) waiter.reject(new Error(msg.error));
  else waiter.resolve(msg.result);
};
worker.onerror = (e) => toast("error", "The simulation stopped", e.message);

function call<T = { ok: true }>(command: Command): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...command });
  });
}
type RoadChange = { changed: number; affected: number };

const workerReady = new Promise((resolve, reject) => pending.set(0, { resolve, reject }));
const getJson = <T>(path: string): Promise<T> => fetch(path).then((r) => r.json());
const [network, flood, district, towns] = await Promise.all([
  getJson<NetworkJson>("/data/network.json"),
  getJson<FeatureCollection>("/data/flood.geojson"),
  getJson<FeatureCollection>("/data/district.geojson"),
  getJson<FeatureCollection>("/data/towns.geojson"),
]);
await workerReady;
const initial = await call<State>({ cmd: "state" });

const roads: Road[] = network.paths.map((path, i) => ({
  i, path, cls: network.classes[i], name: network.names[i], flags: network.flags[i],
  storage: network.storage[i], town: network.town[i],
}));
const townNames = network.towns;
// "Manville borough" reads as "Manville", except where a borough and a township share a name (Hopewell).
const baseName = (n: string) => n.replace(/ (township|borough|city)$/, "");
const baseCounts = townNames.reduce((m, n) => m.set(baseName(n), (m.get(baseName(n)) ?? 0) + 1), new Map<string, number>());
const shortTown = (k: number) => (baseCounts.get(baseName(townNames[k]))! > 1 ? townNames[k] : baseName(townNames[k]));
const floodedBridges = roads.filter((r) => (r.flags & FLAG_BRIDGE) && (r.flags & FLAG_FLOODED)).map((r) => r.i);
const roadLabel = (r: Road) => r.name || `Unnamed ${r.cls.replace("_", " ")}`;

// Live state from worker snapshots (10 Hz while running) and the heavier stats request (1 Hz while running).
const load = new Float32Array(roads.length);
const queued = new Int32Array(roads.length);
const delayMin = new Float32Array(roads.length);
const flow = new Float32Array(roads.length);
let busy: number[] = [];
let delayed: number[] = [];
let routed: number[] = [];
let maxDelay = 1, maxFlow = 1;
let closed = new Set(initial.closed);
let snap: Snapshot = initial;
let stats: Stats | null = null;
let mode: Mode = "queues";
let activeTab: Tab = "overview";
let hovered: PickingInfo | null = null;
let selectedSeg: number | null = null;
let selectedTown: number | null = null;
let flash: { segs: number[]; on: boolean } = { segs: [], on: false };
let version = 0;
let guideStage: 0 | 1 | 2 | null = null;
let guideRun: number | null = null;
let pausedGuideStage: 0 | 1 | 2 | null = null;
let guideLoading = false;
let experience: "tour" | "explore" = "tour";
const guideResults: Summary[] = [];

const tooltip = $("tooltip");
const spark = clickSpark($<HTMLCanvasElement>("sparks"));

function rampColor(x: number): Rgb {
  const t = Math.min(1, Math.max(0, x)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(t));
  const f = t - i;
  return RAMP[i].map((c, k) => Math.round(c + (RAMP[i + 1][k] - c) * f)) as Rgb;
}

// Delay and route counts span several orders of magnitude; a log scale keeps the small ones visible.
const logShare = (v: number, max: number) => Math.log1p(v) / Math.log1p(max);

function heatLayer() {
  const [data, value] = ({
    queues: [busy, (i: number) => load[i]],
    delay: [delayed, (i: number) => logShare(delayMin[i], maxDelay)],
    routes: [routed, (i: number) => logShare(flow[i], maxFlow)],
  } as const)[mode];
  return new PathLayer<number>({
    id: `heat-${mode}`, data, widthUnits: "pixels", capRounded: true, jointRounded: true,
    getPath: (i) => roads[i].path,
    getColor: (i) => rampColor(value(i)),
    getWidth: (i) => 1.4 + 3.6 * value(i),
    updateTriggers: { getColor: version, getWidth: version },
  });
}

function tiles(id: string, url: string, bitmapProps: { tintColor?: Rgb; opacity?: number }) {
  return new TileLayer({
    id, data: url, minZoom: 0, maxZoom: 16, tileSize: 256,
    renderSubLayers: (props) => {
      const { west, south, east, north } = props.tile.bbox as GeoBoundingBox;
      return new BitmapLayer(props, { data: undefined, image: props.data, bounds: [west, south, east, north], ...bitmapProps });
    },
  });
}

function layers() {
  const flashSet = new Set(flash.on ? flash.segs : []);
  return [
    // Esri's dark canvas is mid-gray; the tint multiplies it down to near-black without shifting hue.
    tiles("base", `${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`, { tintColor: [92, 92, 92] }),
    new GeoJsonLayer({
      id: "flood", data: flood, filled: true, stroked: true,
      getFillColor: [57, 135, 229, 46], getLineColor: [57, 135, 229, 110], lineWidthMinPixels: 0.6,
    }),
    new GeoJsonLayer({
      id: "towns", data: towns, filled: true, stroked: true,
      getFillColor: (_f, { index }) => (index === selectedTown ? [255, 255, 255, 12] : [0, 0, 0, 0]),
      getLineColor: (_f, { index }) => (index === selectedTown ? [255, 255, 255, 200] : [255, 255, 255, activeTab === "towns" ? 50 : 0]),
      getLineWidth: (_f, { index }) => (index === selectedTown ? 2 : 1), lineWidthUnits: "pixels",
      updateTriggers: { getFillColor: selectedTown, getLineColor: [selectedTown, activeTab], getLineWidth: selectedTown },
    }),
    new GeoJsonLayer({
      id: "district", data: district, filled: false, stroked: true,
      getLineColor: [255, 255, 255, 110], lineWidthMinPixels: 1,
      // PathStyleExtension's dash props aren't part of GeoJsonLayer's declared props.
      ...({ getDashArray: [4, 4], dashJustified: true } as object),
      extensions: [new PathStyleExtension({ dash: true })],
    }),
    new PathLayer<Road>({
      id: "roads", data: roads, pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 90],
      widthUnits: "pixels", capRounded: true, jointRounded: true,
      getPath: (r) => r.path,
      getColor: (r) => (ROAD_STYLE[r.cls] ?? LOCAL_STYLE)[0],
      getWidth: (r) => (ROAD_STYLE[r.cls] ?? LOCAL_STYLE)[1],
    }),
    heatLayer(),
    new PathLayer<number>({
      id: "closed", data: [...closed], widthUnits: "pixels",
      getPath: (i) => roads[i].path,
      // Fresh closures land white and wide, then ease down to the dashed red closure style.
      getColor: (i) => (flashSet.has(i) ? [255, 255, 255] : CRITICAL),
      getWidth: (i) => (flashSet.has(i) ? 10 : 3),
      ...({ getDashArray: [3, 2], dashJustified: true } as object),
      extensions: [new PathStyleExtension({ dash: true })],
      transitions: { getWidth: { duration: 700, easing: (t: number) => 1 - (1 - t) ** 3 }, getColor: 700 },
      updateTriggers: { getColor: [flash.on, flash.segs], getWidth: [flash.on, flash.segs] },
    }),
    new PathLayer<number>({
      id: "selected", data: selectedSeg == null ? [] : [selectedSeg], widthUnits: "pixels",
      getPath: (i) => roads[i].path, getColor: [255, 255, 255], getWidth: 6, capRounded: true, jointRounded: true,
    }),
    new ScatterplotLayer<number[]>({
      id: "stranded", data: stats?.stranded ?? [], radiusUnits: "pixels", stroked: true, pickable: true,
      getPosition: (p) => [p[0], p[1]], getRadius: (p) => 4 + Math.min(10, Math.sqrt(p[2])),
      getFillColor: CRITICAL, getLineColor: [255, 255, 255], lineWidthMinPixels: 1.5,
      updateTriggers: { getRadius: version },
    }),
    tiles("labels", `${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { opacity: 0.6 }),
  ];
}

const panelWidth = () => (innerWidth > 760 ? 440 : 0);
const [minx, miny, maxx, maxy] = network.bounds;

function fit(bounds: [[number, number], [number, number]], extra: { maxZoom?: number } = {}) {
  // fitBounds asserts if padding exceeds the viewport, which happens in a small window.
  const w = Math.max(innerWidth, 100), h = Math.max(innerHeight, 100);
  const padRight = Math.min(40 + panelWidth(), w * 0.45);
  const padLeft = innerWidth > 760 ? 40 : Math.min(20, w * 0.05);
  const pad = Math.min(70, h * 0.2);
  // On a phone the panel covers the bottom ~55% and the header stack the top 130px.
  const top = innerWidth > 760 ? Math.min(150, h * 0.25) : Math.min(130, h * 0.2);
  const bottom = innerWidth > 760 ? pad : Math.min(h * 0.7 - 80, h - top - 60);
  return new WebMercatorViewport({ width: w, height: h }).fitBounds(bounds, {
    padding: { top, bottom, left: padLeft, right: padRight }, ...extra,
  });
}

const start = fit([[minx, miny], [maxx, maxy]]);
let viewState: MapViewState = {
  longitude: start.longitude, latitude: start.latitude, zoom: start.zoom, pitch: 0, bearing: 0,
};

const map = new Deck({
  parent: $<HTMLDivElement>("map"),
  viewState,
  controller: { dragRotate: false, touchRotate: false },
  onViewStateChange: ({ viewState: next }) => { viewState = next as MapViewState; map.setProps({ viewState }); },
  layers: layers(),
  getCursor: ({ isDragging, isHovering }) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab"),
  onHover: (info) => { hovered = info.object ? info : null; renderTooltip(); },
  onClick: (info) => { toggleRoad(info); },
});
const redraw = () => map.setProps({ layers: layers() });

function flyTo(target: { longitude: number; latitude: number; zoom: number }) {
  viewState = { ...viewState, ...target, transitionDuration: 900, transitionInterpolator: new FlyToInterpolator() };
  map.setProps({ viewState });
}

// Center a point in the part of the map not covered by the panels, not the middle of the window.
function centerOn(longitude: number, latitude: number, zoom: number) {
  const w = innerWidth, h = innerHeight;
  const wide = w > 760;
  const cx = wide ? (40 + (w - panelWidth())) / 2 : w / 2;
  const cy = wide ? h / 2 : (130 + h * 0.3 + 80) / 2;
  const vp = new WebMercatorViewport({ width: w, height: h, longitude, latitude, zoom });
  const [lng, lat] = vp.unproject([w - cx, h - cy]);
  flyTo({ longitude: lng, latitude: lat, zoom });
}

// Tooltip

function renderTooltip() {
  if (!hovered) {
    tooltip.classList.remove("show");
    return;
  }
  const { object, x, y, layer } = hovered;
  if (layer?.id === "stranded") {
    const [, , count, town] = object as number[];
    tooltip.innerHTML = `<h3>${fmt(count)} stranded car${count === 1 ? "" : "s"}</h3>
      <div class="where">${escapeHtml(townNames[town])}</div>
      <div>Every route from here to dry ground crosses a closed road.</div>`;
  } else {
    const r = object as Road;
    const isClosed = closed.has(r.i);
    const tags = `<span class="tag">${r.cls.replace("_", " ")}</span>`
      + (r.flags & FLAG_BRIDGE ? '<span class="tag">bridge</span>' : "")
      + (r.flags & FLAG_FLOODED ? '<span class="tag flood">floodplain</span>' : "")
      + (isClosed ? '<span class="tag closed">closed</span>' : "");
    const d = delayMin[r.i];
    tooltip.innerHTML = `
      <h3>${escapeHtml(roadLabel(r))}</h3>
      <div class="where">${escapeHtml(townNames[r.town])}</div>
      <div class="tags">${tags}</div>
      <dl>
        <dt>Queued now</dt><dd>${fmt(queued[r.i])} / ${fmt(r.storage)}</dd>
        <dt>Routed through</dt><dd>${fmt(flow[r.i])} cars</dd>
        <dt>Delay caused</dt><dd>${d >= 60 ? `${(d / 60).toFixed(1)} veh-h` : `${fmt(d)} veh-min`}</dd>
      </dl>
      <div class="act">${experience === "tour" ? "Switch to Explore to edit roads" : `Click to ${isClosed ? "reopen" : "close"} this road`}</div>`;
  }
  const pad = 14;
  const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
  tooltip.style.left = `${Math.min(x + pad, innerWidth - w - pad)}px`;
  tooltip.style.top = `${y + pad + h > innerHeight ? y - h - pad : y + pad}px`;
  tooltip.classList.add("show");
}

function escapeHtml(s: unknown) {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(s).replace(/[&<>"']/g, (c) => entities[c]);
}

// Toasts

const ICONS = {
  closed: '<svg viewBox="0 0 16 16" fill="none" stroke="#f08a8a" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  open: '<svg viewBox="0 0 16 16" fill="none" stroke="#ededed" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.5 12 13 4.5"/></svg>',
  error: '<svg viewBox="0 0 16 16" fill="#d03b3b"><path d="M8 1.5 15 14H1L8 1.5zm-.75 4.5v4h1.5V6h-1.5zm0 5v1.5h1.5V11h-1.5z"/></svg>',
};

function toast(kind: keyof typeof ICONS, title: string, detail = "") {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `${ICONS[kind]}<span>${escapeHtml(title)}</span>${detail ? `<span class="t-detail">${escapeHtml(detail)}</span>` : ""}`;
  $("toasts").append(el);
  setTimeout(() => { el.classList.add("out"); el.addEventListener("animationend", () => el.remove()); }, 3600);
}

function flashSegments(segs: number[]) {
  flash = { segs, on: true };
  redraw();
  // Render one frame wide and white, then let the layer's transition ease it to the closed style.
  requestAnimationFrame(() => requestAnimationFrame(() => { flash = { segs, on: false }; redraw(); }));
}

const rerouted = (n: number) => (n ? `${fmt(n)} driver${n === 1 ? "" : "s"} rerouted` : "no current routes used it");

async function toggleRoad({ object, x, y, layer }: PickingInfo) {
  if (experience === "tour") return;
  if (!object || layer?.id !== "roads") return;
  const road = object as Road;
  const closing = !closed.has(road.i);
  spark(x, y, closing ? "#d03b3b" : "#ededed");
  if (closing) closed.add(road.i);
  else closed.delete(road.i);
  if (closing) flashSegments([road.i]);
  else redraw();
  renderTooltip();
  renderBridgeButton();
  try {
    const result = await call<RoadChange>({ cmd: closing ? "close" : "open", segs: [road.i] });
    toast(closing ? "closed" : "open", `${closing ? "Closed" : "Reopened"} ${roadLabel(road)}`,
      closing ? rerouted(result.affected) : "");
    refreshStats();
  } catch (err) {
    toast("error", "Couldn't update the road", (err as Error).message);
  }
}

// Flooded-bridges toggle

const bridgeBtn = $<HTMLButtonElement>("close-bridges");
let bridgeBusy = false;

function renderBridgeButton() {
  if (bridgeBusy) return;
  const n = floodedBridges.length;
  const allClosed = floodedBridges.every((i) => closed.has(i));
  bridgeBtn.dataset.state = allClosed ? "closed" : "idle";
  $("bridge-title").textContent = allClosed ? `${n} crossing segments closed` : `Close ${n} crossing segments`;
  $("bridge-sub").textContent = allClosed ? "Click to reopen them" : "Bridges intersecting mapped flood zones";
}

bridgeBtn.onclick = async () => {
  const closing = bridgeBtn.dataset.state !== "closed";
  bridgeBusy = true;
  bridgeBtn.dataset.state = "busy";
  $("bridge-title").textContent = closing ? "Closing bridges…" : "Reopening bridges…";
  $("bridge-sub").textContent = "Recomputing every route";
  try {
    // A floor on the busy state so the spinner reads as a deliberate step rather than a flicker.
    const [result] = await Promise.all([
      call<RoadChange>({ cmd: closing ? "close" : "open", segs: floodedBridges }),
      new Promise((r) => setTimeout(r, 450)),
    ]);
    floodedBridges.forEach((i) => (closing ? closed.add(i) : closed.delete(i)));
    bridgeBusy = false;
    renderBridgeButton();
    bridgeBtn.classList.remove("pop");
    void bridgeBtn.offsetWidth;
    bridgeBtn.classList.add("pop");
    if (closing) flashSegments(floodedBridges);
    else redraw();
    toast(closing ? "closed" : "open", `${closing ? "Closed" : "Reopened"} ${fmt(result.changed)} bridge segments`,
      closing ? rerouted(result.affected) : "");
    refreshStats();
  } catch (err) {
    bridgeBusy = false;
    renderBridgeButton();
    toast("error", "Couldn't change the bridges", (err as Error).message);
  }
};

$("open-all").onclick = async () => {
  const n = closed.size;
  if (!n) return;
  await call({ cmd: "openAll" });
  toast("open", `Reopened ${fmt(n)} road${n === 1 ? "" : "s"}`);
  refreshStats();
};

// Clock, counters, chart

const COUNTER_KEYS = ["evacuated", "on_road", "waiting", "stranded"] as const;
const counters = Object.fromEntries(COUNTER_KEYS.map((k) => [k, countUp($(`n-${k}`))])) as
  Record<(typeof COUNTER_KEYS)[number], ReturnType<typeof countUp>>;
const toPoints = (history: [number, number][], total: number): Point[] => history.map(([t, n]) => ({ t, pct: (100 * n) / total }));
const runs: { current: { id: number; points: Point[] }; previous: { points: Point[] } | null } = {
  current: { id: initial.run, points: toPoints(initial.history, initial.total) },
  previous: initial.previous && {
    points: toPoints(initial.previous.points, initial.previous.total),
  },
};

function fmtClock(t: number) {
  const s = Math.floor(t);
  return [s / 3600, (s % 3600) / 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, "0")).join(":");
}

function applySnapshot(s: Snapshot) {
  const newRun = s.run !== runs.current.id;
  if (newRun) {
    if (runs.current.points.length > 2) runs.previous = runs.current;
    runs.current = { id: s.run, points: [] };
  }
  const pts = runs.current.points;
  const pct = (100 * s.flood_out) / s.total;
  if (!pts.length || s.t > pts[pts.length - 1].t) pts.push({ t: s.t, pct });
  const justFinished = s.done && !snap.done;

  load.fill(0);
  queued.fill(0);
  s.segs.forEach((seg, k) => { load[seg] = s.load[k]; queued[seg] = s.queued[k]; });
  busy = s.segs;
  closed = new Set(s.closed);
  version++;
  snap = s;

  for (const k of COUNTER_KEYS) counters[k].set(s.counts[k]);
  $("stranded-tile").dataset.alert = String(s.counts.stranded > 0);
  $("clock").textContent = fmtClock(s.t);
  $("pct").textContent = `${Math.floor(pct)}% of cars out`;
  $("progress").style.width = `${pct}%`;
  $("closed-count").textContent = `${fmt(closed.size)} road${closed.size === 1 ? "" : "s"} closed`;
  $("closed-count").classList.toggle("active", closed.size > 0);
  $("road-setting").textContent = closed.size ? `${fmt(closed.size)} closed` : roadActions.length ? `${roadActions.length} scheduled` : "All roads open";
  document.body.dataset.complete = String(s.done);
  if (guideStage !== null) renderWatchNote();

  const state = s.done ? "done" : s.running ? "running" : "paused";
  $("status").dataset.state = state;
  $("status-text").textContent = { done: "Complete", running: "Running", paused: s.t > 0 ? "Paused" : "Ready" }[state];
  $("play-label").textContent = s.running ? "Pause" : s.done ? "Run again" : s.t > 0 ? "Resume" : "Run";
  $("play-icon").innerHTML = s.running
    ? '<path d="M4.5 2.5h2.2v11H4.5zM9.3 2.5h2.2v11H9.3z"/>'
    : '<path d="M4 2.8v10.4a.6.6 0 0 0 .9.5l8.4-5.2a.6.6 0 0 0 0-1L4.9 2.3a.6.6 0 0 0-.9.5z"/>';
  renderResult();
  renderSpeed(s.speed);
  renderBridgeButton();
  $<HTMLButtonElement>("play").disabled = guideStage !== null && (guideLoading || s.done);
  if (activeTab === "overview") renderChart(chartHover);
  redraw();
  if (hovered) renderTooltip();
  if (newRun || justFinished) refreshStats();
}

function renderResult() {
  const el = $("result");
  const sum = stats?.summary;
  if (!snap.done || !sum || stats!.run !== snap.run) {
    el.hidden = true;
    el.classList.remove("show");
    return;
  }
  let html = `90% out by <strong>${minutes(sum.t90_min)} min</strong>`;
  if (sum.cleared_min != null) html += ` · last at ${Math.round(sum.cleared_min)} min`;
  if (sum.stranded) html += ` · <strong>${fmt(sum.stranded)}</strong> stranded`;
  if (sum.worst_road) html += ` · worst jam on <strong>${escapeHtml(sum.worst_road)}</strong>`;
  $("result-text").innerHTML = html;
  el.hidden = false;
  el.classList.add("show");
}

const chart = document.getElementById("chart") as unknown as SVGSVGElement;
const chartTip = $("chart-tip");
const M = { top: 8, right: 34, bottom: 18, left: 30 };
let chartHover: number | null = null;

function renderChart(hoverX: number | null = null) {
  const w = chart.clientWidth, h = chart.clientHeight;
  if (!w) return;
  const iw = w - M.left - M.right, ih = h - M.top - M.bottom;
  const all = [runs.current, runs.previous].filter((r) => r !== null);
  const tMax = Math.max(3600, ...all.flatMap((r) => r.points.map((p) => p.t))) * 1.02;
  const xs = (t: number) => M.left + (t / tMax) * iw;
  const ys = (p: number) => M.top + ih - (p / 100) * ih;
  const line = (pts: Point[]) => pts.map((p, i) => `${i ? "L" : "M"}${xs(p.t).toFixed(1)},${ys(p.pct).toFixed(1)}`).join("");

  const step = tMax > 4 * 3600 ? 3600 : tMax > 2 * 3600 ? 1800 : 900;
  let svg = `<defs><linearGradient id="fade" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="#ededed" stop-opacity="0.14"/><stop offset="1" stop-color="#ededed" stop-opacity="0"/>
    </linearGradient></defs><g class="grid">`;
  for (const p of [0, 50, 100]) svg += `<line x1="${M.left}" x2="${M.left + iw}" y1="${ys(p)}" y2="${ys(p)}"/>`;
  svg += `</g><g class="axis">`;
  for (const p of [0, 50, 100]) svg += `<text x="${M.left - 6}" y="${ys(p) + 3}" text-anchor="end">${p}%</text>`;
  for (let t = 0; t <= tMax; t += step) svg += `<text x="${xs(t)}" y="${h - 4}" text-anchor="middle">${Math.round(t / 60)}m</text>`;
  svg += "</g>";

  const prev = runs.previous?.points ?? [];
  const cur = runs.current.points;
  $("legend-prev").hidden = !prev.length;
  if (prev.length) svg += `<path class="prev" d="${line(prev)}"/>`;
  if (cur.length > 1) {
    const last = cur[cur.length - 1];
    svg += `<path class="area" d="${line(cur)}L${xs(last.t)},${ys(0)}L${xs(0)},${ys(0)}Z"/>`;
    svg += `<path class="cur" d="${line(cur)}"/>`;
    svg += `<text class="end" x="${xs(last.t) + 6}" y="${ys(last.pct) + 4}">${Math.floor(last.pct)}%</text>`;
  }

  if (hoverX != null && cur.length) {
    const t = Math.max(0, Math.min(tMax, ((hoverX - M.left) / iw) * tMax));
    const at = (pts: Point[]) => pts.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best), pts[0]);
    const c = at(cur);
    svg += `<line class="cross" x1="${xs(c.t)}" x2="${xs(c.t)}" y1="${M.top}" y2="${M.top + ih}"/>`;
    svg += `<circle class="marker" r="4" cx="${xs(c.t)}" cy="${ys(c.pct)}"/>`;
    let tip = `${Math.round(c.t / 60)} min · <b>${c.pct.toFixed(1)}%</b> this run`;
    if (prev.length) {
      const p = at(prev);
      svg += `<circle class="marker" r="4" cx="${xs(p.t)}" cy="${ys(p.pct)}" style="fill:var(--faint)"/>`;
      tip += `<br><b>${p.pct.toFixed(1)}%</b> previous`;
    }
    chartTip.innerHTML = tip;
    chartTip.style.left = `${Math.min(xs(c.t) + 10, w - chartTip.offsetWidth)}px`;
    chartTip.style.top = `${M.top}px`;
    chartTip.style.opacity = "1";
  } else {
    chartTip.style.opacity = "0";
  }
  chart.innerHTML = svg;
}

chart.addEventListener("pointermove", (e) => { chartHover = e.offsetX; renderChart(chartHover); });
chart.addEventListener("pointerleave", () => { chartHover = null; renderChart(); });

// Stats: trip outcomes, bottlenecks, towns, comparison

let statsInFlight = false;
async function refreshStats() {
  if (statsInFlight) return;
  statsInFlight = true;
  const requestedExperience = experience;
  let next: Stats;
  try {
    next = await call<Stats>({ cmd: "stats" });
  } finally {
    statsInFlight = false;
  }
  if (requestedExperience !== experience || next.run !== snap.run || (snap.done && !next.summary.done)) {
    void refreshStats();
    return;
  }
  stats = next;
  if (guideStage !== null && !guideLoading && next.run === guideRun && next.run === snap.run && next.summary.done) {
    guideResults[guideStage] = next.summary;
    renderGuide();
  }
  delayMin.fill(0);
  flow.fill(0);
  next.delay.segs.forEach((seg, k) => { delayMin[seg] = next.delay.veh_min[k]; });
  next.flow.segs.forEach((seg, k) => { flow[seg] = next.flow.cars[k]; });
  delayed = next.delay.segs;
  routed = next.flow.segs;
  maxDelay = next.delay.veh_min.reduce((a, b) => Math.max(a, b), 1);
  maxFlow = next.flow.cars.reduce((a, b) => Math.max(a, b), 1);
  version++;

  renderDemand(next.demand);
  if (next.demand.warning !== warning) { warning = next.demand.warning; renderWarning(); }
  const sum = next.summary;
  const tile = (v: number | null, unit: string) => (v == null ? "—" : `${unit === "veh-h" ? fmt(v) : minutes(v)}<small>${unit}</small>`);
  $("m-t90").innerHTML = tile(sum.t90_min, "min");
  $("m-last").innerHTML = tile(sum.cleared_min, "min");
  $("m-stranded").innerHTML = sum.stranded_all > sum.stranded
    ? `${fmt(sum.stranded)}<small>+${fmt(sum.stranded_all - sum.stranded)} neighbors</small>` : fmt(sum.stranded);
  $("m-median").innerHTML = tile(sum.median_min, "min");
  $("m-delay").innerHTML = tile(sum.mean_delay_min, "min");
  $("m-vh").innerHTML = tile(sum.delay_veh_h, "veh-h");
  $("outcome-hint").textContent = snap.t === 0 ? "Run the simulation to see the outcome for participating flood-zone cars."
    : sum.done ? "Run complete. Check both time and cars without a route before deciding whether this plan helped."
    : "Simulation in progress. These results will update as cars reach exits.";
  $("compare-badge").hidden = !next.previous;

  renderLegend();
  renderResult();
  if (activeTab === "bottlenecks") renderBottlenecks();
  if (activeTab === "towns") renderTowns();
  if (activeTab === "compare") renderCompare();
  redraw();
}
setInterval(() => { if (snap.running) refreshStats(); }, 1000);

function renderDemand(d: State["demand"]) {
  $("d-people").textContent = fmt(d.people);
  $("d-households").textContent = fmt(d.households);
  $("d-cars").textContent = fmt(d.cars);
  $("tour-people").textContent = fmt(d.people);
  $("d-novehicle").innerHTML = `${fmt(d.no_vehicle)}<small>households</small>`;
  $("d-note").innerHTML = `<strong>${fmt(d.no_vehicle_people)}</strong> people live in flood-zone households with no vehicle. `
    + `They aren't in the traffic sim and need buses or rides out. One car per household with a vehicle.`;
  $("rate-sub").textContent = `${fmt(d.cars)} cars, one per household with a vehicle`;
  $("shadow-sub").textContent = `${fmt(d.shadow_cars)} cars from ${fmt(d.shadow_households)} households within 200 m`;
}

function renderBottlenecks() {
  const list = $("bottlenecks");
  // Keep an open editor stable while live statistics arrive.
  if (list.dataset.run === String(stats?.run) && list.querySelector(".closure-plan[open]")) return;
  list.dataset.run = String(stats?.run);
  const rows = stats?.bottlenecks ?? [];
  if (!rows.length) {
    list.innerHTML = '<div class="empty">No delay yet. Run the simulation to see where traffic backs up.</div>';
    return;
  }
  const top = rows[0].delay_veh_h || 1;
  list.innerHTML = rows.map((b, k) => {
    const r = roads[b.seg];
    const tags = (r.flags & FLAG_BRIDGE ? '<span class="tag">bridge</span>' : "")
      + (r.flags & FLAG_FLOODED ? '<span class="tag flood">floodplain</span>' : "")
      + (b.closed ? '<span class="tag closed">closed</span>' : "");
    const contributors = b.contributors.length
      ? b.contributors.map((row) => `${shortTown(row.town)} ${fmt(row.cars)}`).join(" · ") : "No active routes use it";
    const action = roadActions.find((candidate) => candidate.segment === b.seg);
    const actionChoice = action?.kind === "capacity" ? action.multiplier === 0.5 ? "half" : "boost" : "close";
    const option = (value: string, label: string) => `<option value="${value}"${actionChoice === value ? " selected" : ""}>${label}</option>`;
    return `<div class="list-row" tabindex="0" style="--k:${k}" data-seg="${b.seg}" aria-current="${b.seg === selectedSeg}">
      <span class="rank">${k + 1}</span>
      <div class="row-main">
        <div class="row-title">${escapeHtml(roadLabel(r))}</div>
        <div class="row-sub">${escapeHtml(townNames[b.town])} ${tags}</div>
        <div class="row-sub">Traffic from ${escapeHtml(contributors)}</div>
        <div class="bar"><i style="width:${(100 * b.delay_veh_h) / top}%"></i></div>
      </div>
      <div class="row-val"><b>${b.delay_veh_h.toFixed(1)} veh-h</b><span>${fmt(b.queued)} queued · ${fmt(b.flow)} routed</span></div>
      <details class="closure-plan"><summary>Test a change on this road</summary><label>Action <select aria-label="Action for ${escapeHtml(roadLabel(r))}">${option("close", "Close")}${option("half", "Half capacity")}${option("boost", "50% more capacity")}</select></label><label>Minutes after the run starts <input type="number" min="0" max="300" step="5" value="${Math.round((action?.startsAtS ?? 1800) / 60)}" aria-label="Action time for ${escapeHtml(roadLabel(r))} in minutes"></label><p class="micro">Capacity is how many cars can pass each hour. Scheduling restarts the run.</p><button class="btn" data-schedule="${b.seg}">${action ? "Update" : "Schedule change"}</button></details>
    </div>`;
  }).join("");
  for (const row of list.querySelectorAll<HTMLElement>(".list-row")) {
    const go = () => focusSegment(Number(row.dataset.seg));
    row.onclick = (e) => { if (!(e.target as HTMLElement).closest(".closure-plan")) go(); };
    row.onkeydown = (e) => { if (e.key === "Enter" && e.target === row) go(); };
  }
  for (const button of list.querySelectorAll<HTMLButtonElement>("[data-schedule]")) {
    button.disabled = guideStage !== null;
    button.onclick = async () => {
      const segment = Number(button.dataset.schedule);
      const input = button.parentElement!.querySelector<HTMLInputElement>("input")!;
      const choice = button.parentElement!.querySelector<HTMLSelectElement>("select")!.value;
      const startsAtS = Math.max(0, Math.min(300, Number(input.value))) * 60;
      roadActions = roadActions.filter((action) => action.segment !== segment);
      roadActions.push({ segment, startsAtS, kind: choice === "close" ? "close" : "capacity",
        multiplier: choice === "half" ? 0.5 : choice === "boost" ? 1.5 : undefined });
      toast("closed", `${roadLabel(roads[segment])} action scheduled`, `${Math.round(startsAtS / 60)} minutes after the run starts`);
      renderRoadActions();
      button.closest("details")!.open = false;
      await changeScenario();
      renderBottlenecks();
    };
  }
}

function focusSegment(seg: number) {
  selectedSeg = selectedSeg === seg ? null : seg;
  if (selectedSeg != null) {
    const road = roads[seg];
    const at = road.path[Math.floor(road.path.length / 2)];
    centerOn(at[0], at[1], 15.5);
    if (mode !== "delay") setMode("delay");
  }
  renderBottlenecks();
  redraw();
}

type TownSort = "risk" | "name" | "cars" | "pct" | "cleared" | "stranded" | "novehicle";
let townSort: TownSort = "risk";
function renderTowns() {
  const body = $("towns").querySelector("tbody")!;
  const rows = [...(stats?.towns ?? [])];
  const share = (t: TownRow) => (t.cars ? t.evacuated / t.cars : 1);
  const sorters: Record<TownSort, (a: TownRow, b: TownRow) => number> = {
    risk: (a, b) => b.stranded - a.stranded || b.remaining - a.remaining || (b.cleared_min ?? 0) - (a.cleared_min ?? 0)
      || b.no_vehicle - a.no_vehicle,
    name: (a, b) => townNames[a.town].localeCompare(townNames[b.town]),
    cars: (a, b) => b.cars - a.cars,
    pct: (a, b) => share(a) - share(b),
    cleared: (a, b) => (b.cleared_min ?? Infinity) - (a.cleared_min ?? Infinity),
    stranded: (a, b) => b.stranded - a.stranded,
    novehicle: (a, b) => b.no_vehicle - a.no_vehicle,
  };
  rows.sort(sorters[townSort]);
  for (const btn of $("towns").querySelectorAll<HTMLElement>("th button")) btn.setAttribute("aria-pressed", String(btn.dataset.sort === townSort));
  body.innerHTML = rows.map((t, k) => {
    const p = Math.floor(100 * share(t));
    return `<tr tabindex="0" data-town="${t.town}" style="animation-delay:${k * 18}ms" aria-current="${t.town === selectedTown}"
        title="${fmt(t.people)} people in ${fmt(t.households)} flood-zone households · median trip ${minutes(t.median_min)} min · avg delay ${minutes(t.delay_min)} min">
      <td class="town-name" title="${escapeHtml(townNames[t.town])}">${escapeHtml(shortTown(t.town))}</td>
      <td class="r num">${fmt(t.cars)}</td>
      <td class="r num">${p}%</td>
      <td class="r num ${t.cleared_min == null ? "dim" : ""}">${t.cleared_min == null ? "—" : `${Math.round(t.cleared_min)}m`}</td>
      <td class="r num ${t.stranded ? "crit" : "dim"}">${fmt(t.stranded)}</td>
      <td class="r num ${t.no_vehicle ? "" : "dim"}" title="${fmt(t.no_vehicle_people)} people">${fmt(t.no_vehicle)}</td>
    </tr>`;
  }).join("");
  for (const tr of body.querySelectorAll<HTMLElement>("tr")) {
    const go = () => focusTown(Number(tr.dataset.town));
    tr.onclick = go;
    tr.onkeydown = (e) => { if (e.key === "Enter") go(); };
  }
}

for (const btn of $("towns").querySelectorAll<HTMLElement>("th button")) {
  btn.onclick = () => { townSort = townSort === btn.dataset.sort ? "risk" : btn.dataset.sort as TownSort; renderTowns(); };
}

function focusTown(k: number) {
  selectedTown = selectedTown === k ? null : k;
  const feature: Feature | undefined = towns.features[k];
  if (selectedTown != null && feature) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const walk = (c: unknown[]): void => {
      if (typeof c[0] !== "number") return c.forEach((inner) => walk(inner as unknown[]));
      const [x, y] = c as Position;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    };
    walk((feature.geometry as { coordinates: unknown[] }).coordinates);
    const v = fit([[x0, y0], [x1, y1]], { maxZoom: 15 });
    flyTo({ longitude: v.longitude, latitude: v.latitude, zoom: v.zoom });
  }
  renderTowns();
  redraw();
}

// [label, summary key, unit, which direction is better: -1 lower, 0 neutral]
type NumericKey = { [K in keyof Summary]: Summary[K] extends number | null ? K : never }[keyof Summary];
const COMPARE_ROWS: [string, NumericKey, string, number][] = [
  ["50% out by", "t50_min", "min", -1],
  ["90% out by", "t90_min", "min", -1],
  ["Last successful arrival", "cleared_min", "min", -1],
  ["No route, flood zone", "stranded", "cars", -1],
  ["Stranded, all", "stranded_all", "cars", -1],
  ["Median trip", "median_min", "min", -1],
  ["90th pct trip", "p90_min", "min", -1],
  ["Extra time per car", "mean_delay_min", "min", -1],
  ["Combined queue delay", "delay_veh_h", "car-hours", -1],
  ["Roads closed", "closed", "", 0],
  ["Scheduled closures", "scheduled_closures", "", 0],
  ["Households leaving", "rate", "%", 0],
  ["Neighbors leaving", "shadow", "%", 0],
  ["Flood-zone cars", "cars", "", 0],
  ["Neighbor cars", "shadow_cars", "", 0],
];
const WARNING_LABEL: Record<string, string> = { sudden: "Sudden", short: "Hours", long: "A day" };
const ARROW_UP = '<svg viewBox="0 0 10 10" fill="currentColor"><path d="M5 1 9.5 8h-9z"/></svg>';
const ARROW_DOWN = '<svg viewBox="0 0 10 10" fill="currentColor"><path d="M5 9 .5 2h9z"/></svg>';

function renderCompare() {
  const cur = stats?.summary, prev = stats?.previous;
  $("compare-empty").hidden = !!prev;
  $("compare").hidden = !prev;
  $("compare-details").hidden = !prev;
  renderSavedPlans();
  if (!cur || !prev) return;
  const show = (v: number | null, unit: string) => (v == null ? '<span class="dim">—</span>' : unit === "min" ? minutes(v) : unit === "car-hours" ? v.toFixed(1) : fmt(v));
  const rows = COMPARE_ROWS.map(([label, key, unit, better]) => {
    const a = cur[key], b = prev[key];
    let change = '<span class="dim">—</span>';
    if (a != null && b != null) {
      const d = a - b;
      if (Math.abs(d) < 0.05) {
        change = '<span class="dim">same</span>';
      } else {
        const tone = better === 0 ? "" : Math.sign(d) === better ? "better" : "worse";
        const size = unit === "min" || unit === "car-hours" ? Math.abs(d).toFixed(1) : fmt(Math.abs(d));
        change = `<span class="delta ${tone}">${d > 0 ? ARROW_UP : ARROW_DOWN}${d > 0 ? "+" : "−"}${size}</span>`;
      }
    }
    const detail = !["t90_min", "stranded", "mean_delay_min", "delay_veh_h"].includes(key);
    return `<tr data-detail="${detail}"><td>${label}${unit ? ` <span class="dim">${unit}</span>` : ""}</td>
      <td class="r num">${show(a, unit)}</td><td class="r num">${show(b, unit)}</td><td class="r">${change}</td></tr>`;
  });
  const road = (v: string | null) => `<td class="r text" title="${escapeHtml(v ?? "")}">${escapeHtml(v ?? "—")}</td>`;
  rows.push(`<tr data-detail="true"><td>Warning time</td><td class="r">${WARNING_LABEL[cur.warning]}</td><td class="r">${WARNING_LABEL[prev.warning] ?? "—"}</td><td></td></tr>`);
  rows.push(`<tr data-detail="true"><td>Worst bottleneck</td>${road(cur.worst_road)}${road(prev.worst_road)}<td></td></tr>`);
  $("compare").querySelector("tbody")!.innerHTML = rows.join("");
}

$("compare-details").onclick = () => {
  const expanded = $("compare").classList.toggle("show-details");
  $("compare-details").setAttribute("aria-expanded", String(expanded));
  $("compare-details").textContent = expanded ? "Show key outcomes only" : "Show all metrics and settings";
};

function renderSavedPlans() {
  const list = $("saved-plans");
  if (!savedPlans.length) {
    list.innerHTML = '<div class="empty">Save completed runs to compare and reopen them later.</div>';
    return;
  }
  list.innerHTML = savedPlans.map((plan, index) => `<div class="saved-plan">
    <strong title="${escapeHtml(plan.name)}">${escapeHtml(plan.name)}</strong>
    <span>${minutes(plan.summary.t90_min)}m to 90%</span>
    <span>${fmt(plan.summary.stranded)} stranded</span>
    <span>${minutes(plan.summary.mean_delay_min)}m delay</span>
    <button class="btn small" data-load-plan="${index}">Load</button>
    <button class="btn small" data-remove-plan="${index}" aria-label="Remove ${escapeHtml(plan.name)}">×</button>
  </div>`).join("");
  for (const button of list.querySelectorAll<HTMLButtonElement>("[data-load-plan]")) {
    button.onclick = async () => {
      if (guideStage !== null) return;
      const plan = savedPlans[Number(button.dataset.loadPlan)];
      rate.value = String(plan.rate);
      shadow.value = String(plan.shadow);
      warning = plan.warning;
      zonePlans = plan.zones.map((zone) => ({ ...zone }));
      roadActions = plan.roadActions.map((action) => ({ ...action }));
      showSliders();
      renderWarning();
      renderSchedule();
      renderRoadActions();
      await changeScenario();
      setTab("overview");
    };
  }
  for (const button of list.querySelectorAll<HTMLButtonElement>("[data-remove-plan]")) {
    button.onclick = () => {
      savedPlans.splice(Number(button.dataset.removePlan), 1);
      localStorage.setItem("evacsim-plans", JSON.stringify(savedPlans));
      renderSavedPlans();
    };
  }
}

// Map layer switch and legend

const LEGENDS: Record<Mode, [string, () => string, () => string]> = {
  queues: ["Orange roads show traffic building up.", () => "More space", () => "Full road"],
  delay: ["Brighter roads caused more waiting. Scale is compressed to show smaller jams too.", () => "1 car-minute", () => `${fmt(maxDelay)} car-min`],
  routes: ["Brighter roads have more cars still planning to use them. Scale is compressed.", () => "1 car", () => `${fmt(maxFlow)} cars`],
};

function renderLegend() {
  const [title, lo, hi] = LEGENDS[mode];
  $("legend-title").textContent = title;
  $("legend-lo").textContent = lo();
  $("legend-hi").textContent = hi();
}

function placeThumb(seg: HTMLElement, active: HTMLElement | undefined) {
  if (!active) return;
  const thumb = seg.querySelector<HTMLElement>(".thumb")!;
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.transform = `translateX(${active.offsetLeft}px)`;
}

function setMode(next: Mode) {
  mode = next;
  const buttons = [...$("modes").querySelectorAll<HTMLElement>("button")];
  buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  placeThumb($("modes"), buttons.find((b) => b.dataset.mode === mode));
  renderLegend();
  redraw();
}
for (const b of $("modes").querySelectorAll<HTMLElement>("button")) b.onclick = () => setMode(b.dataset.mode as Mode);

// Tabs

function setTab(name: Tab) {
  activeTab = name;
  const buttons = [...$("tabbar").querySelectorAll<HTMLElement>("button")];
  buttons.forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.tab === name));
    b.tabIndex = b.dataset.tab === name ? 0 : -1;
    b.id = `tab-${b.dataset.tab}`;
    b.setAttribute("aria-controls", `panel-${b.dataset.tab}`);
  });
  const btn = buttons.find((b) => b.dataset.tab === name)!;
  const line = $("tabbar").querySelector<HTMLElement>(".underline")!;
  line.style.width = `${btn.offsetWidth - 20}px`;
  line.style.transform = `translateX(${btn.offsetLeft + 10}px)`;
  for (const p of document.querySelectorAll<HTMLElement>(".tab-panel")) {
    p.hidden = p.dataset.panel !== name;
    p.id = `panel-${p.dataset.panel}`;
    p.setAttribute("role", "tabpanel");
    p.setAttribute("aria-labelledby", `tab-${p.dataset.panel}`);
  }
  if (name !== "towns") selectedTown = null;
  if (name !== "bottlenecks") selectedSeg = null;
  if (name === "overview") renderChart();
  if (name === "bottlenecks") renderBottlenecks();
  if (name === "towns") renderTowns();
  if (name === "compare") renderCompare();
  redraw();
}
for (const b of $("tabbar").querySelectorAll<HTMLElement>("button")) b.onclick = () => setTab(b.dataset.tab as Tab);
$("tabbar").onkeydown = (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const tabs = [...$("tabbar").querySelectorAll<HTMLButtonElement>("button")];
  const current = tabs.findIndex((tab) => tab.dataset.tab === activeTab);
  const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
    : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  setTab(tabs[index].dataset.tab as Tab);
  tabs[index].focus();
};
$("chart-details").addEventListener("toggle", () => renderChart());

// Run controls

const speedSeg = $("speed");
for (const steps of initial.speeds) {
  const b = document.createElement("button");
  b.textContent = `${Math.round((steps * 5) / 0.1)}×`;
  b.title = `${((steps * 5) / 0.1 / 60).toFixed(1)} sim-minutes per second`;
  b.dataset.steps = String(steps);
  b.onclick = () => call({ cmd: "speed", steps });
  speedSeg.append(b);
}
function renderSpeed(steps: number) {
  const buttons = [...speedSeg.querySelectorAll<HTMLElement>("button")];
  const active = buttons.find((b) => Number(b.dataset.steps) === steps);
  buttons.forEach((b) => b.setAttribute("aria-pressed", String(b === active)));
  placeThumb(speedSeg, active);
}

const rate = $<HTMLInputElement>("rate");
const shadow = $<HTMLInputElement>("shadow");
let warning: Warning = initial.demand.warning;
let zonePlans: ZonePlan[] = initial.demand.zones.map((zone) => ({ ...zone }));
let roadActions: RoadAction[] = [];
function renderRoadActions() {
  $("road-setting").textContent = closed.size ? `${fmt(closed.size)} closed` : roadActions.length ? `${roadActions.length} scheduled` : "All roads open";
  if (roadActions.length > 20) {
    $("road-actions").innerHTML = `<details><summary>${roadActions.length} scheduled road actions</summary><div id="road-action-list"></div></details>`;
  }
  const actionList = roadActions.length > 20 ? $("road-action-list") : $("road-actions");
  actionList.innerHTML = roadActions.map((action, index) => {
    const label = action.kind === "capacity" ? `${Math.round((action.multiplier ?? 1) * 100)}% capacity` : "close";
    return `<div class="road-action"><span>${escapeHtml(roadLabel(roads[action.segment]))}</span><span>${label} at ${Math.round(action.startsAtS / 60)}m</span><button class="btn small" data-remove-action="${index}" aria-label="Remove action">×</button></div>`;
  }).join("");
  for (const button of $("road-actions").querySelectorAll<HTMLButtonElement>("[data-remove-action]")) {
    button.onclick = async () => {
      roadActions.splice(Number(button.dataset.removeAction), 1);
      renderRoadActions();
      await changeScenario();
    };
  }
}
const togglePlay = () => {
  if (experience === "tour" && guideStage === null) return;
  if (guideStage !== null && (guideLoading || snap.done)) return;
  return call({ cmd: snap.running ? "pause" : "play" });
};
const resetRun = () => call({
  cmd: "reset", rate: Number(rate.value), shadow: Number(shadow.value), warning, zones: zonePlans, roadActions,
});
const changeScenario = async () => { await resetRun(); refreshStats(); };
$("play").onclick = togglePlay;
$("reset").onclick = resetRun;

rate.value = String(initial.demand.rate);
shadow.value = String(initial.demand.shadow);
function renderSchedule() {
  const changed = zonePlans.filter((zone) => zone.orderTimeS > 0 || zone.participation !== Number(rate.value)).length;
  $("schedule-summary").textContent = changed ? `${changed} town${changed === 1 ? "" : "s"} changed` : "All towns at once";
  $("people-setting").textContent = new Set(zonePlans.map((zone) => zone.participation)).size > 1 ? "Varies by town" : `${rate.value}% of households with cars`;
  renderWarning();
  $("zone-schedule").innerHTML = zonePlans.map((zone) => `<div class="zone-row" data-town="${zone.town}">
    <label title="${escapeHtml(townNames[zone.town])}">${escapeHtml(shortTown(zone.town))}</label>
    <span class="field"><input data-field="order" type="number" min="0" max="180" step="5" value="${zone.orderTimeS / 60}" aria-label="${escapeHtml(shortTown(zone.town))} order time in minutes"><span class="unit">m</span></span>
    <span class="field"><input data-field="participation" type="number" min="5" max="100" step="5" value="${zone.participation}" aria-label="${escapeHtml(shortTown(zone.town))} participation percentage"><span class="unit">%</span></span>
  </div>`).join("");
  for (const input of $("zone-schedule").querySelectorAll<HTMLInputElement>("input")) {
    input.onchange = async () => {
      const town = Number(input.closest<HTMLElement>(".zone-row")!.dataset.town);
      const zone = zonePlans.find((candidate) => candidate.town === town)!;
      const value = Number(input.value);
      if (input.dataset.field === "order") zone.orderTimeS = Math.max(0, Math.min(180, value)) * 60;
      else zone.participation = Math.max(5, Math.min(100, value));
      renderSchedule();
      await changeScenario();
    };
  }
}
const showSliders = () => {
  $("rate-val").textContent = `${rate.value}%`;
  $("shadow-val").textContent = `${shadow.value}%`;
  $("people-setting").textContent = `${rate.value}% leave · ${shadow.value}% of neighbors`;
};
showSliders();
rate.oninput = shadow.oninput = showSliders;
rate.onchange = () => {
  zonePlans.forEach((zone) => { zone.participation = Number(rate.value); });
  renderSchedule();
  changeScenario();
};
shadow.onchange = changeScenario;
$("reset-schedule").onclick = () => {
  zonePlans.forEach((zone) => { zone.orderTimeS = 0; zone.participation = Number(rate.value); });
  renderSchedule();
  changeScenario();
};
$("save-plan").onclick = () => {
  if (!snap.done || !stats || stats.run !== snap.run) {
    toast("error", "Finish the run before saving its result");
    return;
  }
  const nameInput = $<HTMLInputElement>("plan-name");
  const name = nameInput.value.trim() || `Plan ${savedPlans.length + 1}`;
  savedPlans.push({
    name, summary: stats.summary, rate: Number(rate.value), shadow: Number(shadow.value), warning,
    zones: zonePlans.map((zone) => ({ ...zone })), roadActions: roadActions.map((action) => ({ ...action })),
  });
  localStorage.setItem("evacsim-plans", JSON.stringify(savedPlans));
  nameInput.value = "";
  renderSavedPlans();
  toast("open", `Saved ${name}`);
};
$("export-plans").onclick = () => {
  if (!savedPlans.length) {
    toast("error", "Save at least one completed plan before exporting");
    return;
  }
  const quote = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const header = ["Plan", "90% out (min)", "Cleared (min)", "Stranded", "Mean delay (min)", "Total delay (veh-h)", "Scheduled closures"];
  const rows = savedPlans.map((plan) => [plan.name, plan.summary.t90_min, plan.summary.cleared_min,
    plan.summary.stranded, plan.summary.mean_delay_min, plan.summary.delay_veh_h, plan.summary.scheduled_closures]);
  const blob = new Blob([[header, ...rows].map((row) => row.map(quote).join(",")).join("\n")], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "evacuation-plans.csv";
  link.click();
  URL.revokeObjectURL(link.href);
};
$("print-plan").onclick = () => print();
$("stagger-schedule").onclick = () => {
  staggerZones(zonePlans, network.demand.no_vehicle);
  renderSchedule();
  changeScenario();
};

const warningSeg = $("warning");
function renderWarning() {
  const buttons = [...warningSeg.querySelectorAll<HTMLElement>("button")];
  buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.warning === warning)));
  placeThumb(warningSeg, buttons.find((b) => b.dataset.warning === warning));
  const departure = { sudden: "25 minutes", short: "about an hour", long: "about three hours" }[warning];
  $("warning-explanation").textContent = `About 95% are ready to depart within ${departure} of their town’s order. These are assumed response times.`;
  $("departure-setting").textContent = zonePlans.some((zone) => zone.orderTimeS > 0) ? "Orders vary by town" : `Depart over ${departure}`;
}
for (const b of warningSeg.querySelectorAll<HTMLElement>("button")) {
  b.onclick = () => { warning = b.dataset.warning as Warning; renderWarning(); changeScenario(); };
}

const guideTitles = ["First, let everyone leave.", "Now, take away some routes.", "Would leaving in waves help?"];
const guideDescriptions = [
  "Every town receives its order at the same time. Roads stay open. This gives us a baseline to compare against.",
  "Close the flood-zone crossings after 30 minutes. Keep the same cars and departure times so we can isolate the effect.",
  "Keep the closures. Give towns orders in four waves, 15 minutes apart. Less simultaneous traffic sounds helpful. Is it?",
];

function renderWatchNote() {
  const note = $("guide-observe");
  note.hidden = guideStage === null || snap.done;
  if (guideStage === null) return;
  note.textContent = guideStage === 0 ? "Watch the orange roads: brighter means more traffic. The clock runs faster than real time."
    : guideStage === 1 ? snap.t < 1800 ? "Watch for red crossings at minute 30. Cars will have to find another way."
      : "The crossings are closed. Red dots mark cars that have no route to an exit."
    : "Later orders may mean less traffic, but some crossings can close before a town leaves.";
}

function renderGuide() {
  const active = guideStage !== null;
  const complete = guideStage !== null && !!guideResults[guideStage];
  document.body.dataset.view = experience;
  document.body.dataset.started = String(experience === "explore" || active);
  document.body.dataset.complete = String(snap.done);
  $("dock").inert = active;
  $("saved-plans").inert = active;
  $("save-plan").parentElement!.inert = active;
  $<HTMLButtonElement>("reset").disabled = active;
  $<HTMLButtonElement>("play").disabled = active && (guideLoading || snap.done);
  for (const view of ["tour", "explore"] as const) {
    const button = $<HTMLButtonElement>(`view-${view}`);
    button.setAttribute("aria-pressed", String(experience === view));
    button.disabled = guideLoading;
  }
  $("guide-exit").hidden = !active || (guideStage === 2 && complete);
  $("guide-intro").hidden = active;
  $("guide-setup").hidden = !active;
  $("guide-kicker").textContent = active ? `Experiment ${guideStage! + 1} of 3 · hypothetical` : "Three quick experiments";
  const next = $<HTMLButtonElement>("guide-next");
  next.disabled = guideLoading || (active && !complete);
  next.hidden = active && !complete && !guideLoading;
  next.textContent = !active ? "Start with open roads" : guideLoading ? "Preparing run…"
    : guideStage === 0 ? "Now close the crossings" : guideStage === 1 ? "Try staggered orders" : "Try your own plan";
  $("guide-title").textContent = guideStage !== null ? guideTitles[guideStage] : "Can everyone get out before roads close?";
  $("guide-description").textContent = guideStage !== null ? guideDescriptions[guideStage]
    : "Try three evacuation plans on real New Jersey roads. See how a small change can leave more cars without a way out.";
  $("guide-footnote").textContent = active ? "Same cars in every run. These closures are hypothetical, not predicted bridge failures."
    : snap.t > 0 ? "Starting the tour replaces the current scenario. Your saved results stay."
    : "Real road and Census data. Hypothetical closures. This is an experiment, not a flood forecast.";
  for (const [index, step] of [...document.querySelectorAll<HTMLElement>(".tour-steps li")].entries()) {
    if (index === guideStage) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
    step.dataset.done = String(!!guideResults[index]);
  }
  if (active) {
    $("guide-setup").innerHTML = `<div><dt>Town orders</dt><dd>${guideStage === 2 ? "0, 15, 30, 45 minutes" : "All at minute 0"}</dd></div>
      <div><dt>Roads</dt><dd>${guideStage === 0 ? "All open" : `${fmt(floodedBridges.length)} bridge segments close at 30 min`}</dd></div>`;
  }
  renderWatchNote();
  const results = $("guide-results");
  if (!complete || guideStage === null) { results.replaceChildren(); return; }
  const outcome = guideResults[guideStage];
  const before = guideStage > 0 ? guideResults[guideStage - 1] : null;
  const timeChange = before && outcome.t90_min !== null && before.t90_min !== null ? outcome.t90_min - before.t90_min : null;
  const timeDelta = timeChange === null ? "" : Math.abs(timeChange) < 0.05 ? "Same as previous run"
    : `${Math.abs(timeChange).toFixed(1)} min ${timeChange > 0 ? "slower" : "faster"} than before`;
  const strandedChange = before ? outcome.stranded - before.stranded : null;
  const strandedDelta = strandedChange === null ? "" : strandedChange === 0 ? "Same as previous run"
    : `${fmt(Math.abs(strandedChange))} ${strandedChange > 0 ? "more" : "fewer"} than before`;
  const insight = guideStage === 0 ? "This is our baseline. Next, test what happens when crossings close."
    : guideStage === 1 ? outcome.stranded > 0 ? "Most cars still get out. The red dots show where the plan fails." : "Every participating car found an exit under these assumptions."
    : strandedChange !== null && strandedChange > 0 ? "Delaying some orders left more cars without a route. Staggering is not always better."
    : "Judge the schedule by both travel time and cars without a route.";
  const row = (label: string, values: string[]) => `<tr><th scope="row">${label}</th>${values.map((v) => `<td>${v}</td>`).join("")}</tr>`;
  results.innerHTML = `<div class="guide-result-cards"><div><strong>${outcome.t90_min === null ? "Not reached" : `${minutes(outcome.t90_min)} min`}</strong><span>to get 90% of cars out</span><small>${timeDelta}</small></div>
    <div><strong>${fmt(outcome.stranded)}</strong><span>cars without a route</span><small>${strandedDelta}</small></div></div>
    <p class="guide-conclusion">${insight}</p>
    <details class="explanation"><summary>See the numbers side by side</summary><table><caption>Participating flood-zone cars</caption>
    <thead><tr><th scope="col">Metric</th>${["Open", "Closed", "Waves"].slice(0, guideResults.length).map((label) => `<th scope="col">${label}</th>`).join("")}</tr></thead>
    <tbody>${row("90% out (min)", guideResults.map((s) => minutes(s.t90_min)))}
    ${row("No route (cars)", guideResults.map((s) => fmt(s.stranded)))}
    ${row("Queue delay (hours)", guideResults.map((s) => s.delay_veh_h?.toFixed(1) ?? "—"))}</tbody></table>
    <p>Queue delay adds up waiting across all cars, including neighbors. One hour can mean 60 cars each waiting one minute.</p></details>`;
}

async function setExperience(view: "tour" | "explore") {
  if (guideLoading || experience === view) return;
  guideLoading = true;
  renderGuide();
  try {
    await call({ cmd: "pause" });
    if (experience === "tour") pausedGuideStage = guideStage;
    guideStage = null;
    const session = await call<{ state: State; roadActions: RoadAction[] }>({ cmd: "experience", view });
    experience = view;
    guideStage = view === "tour" ? pausedGuideStage : null;
    rate.value = String(session.state.demand.rate);
    shadow.value = String(session.state.demand.shadow);
    warning = session.state.demand.warning;
    zonePlans = session.state.demand.zones.map((zone) => ({ ...zone }));
    roadActions = session.roadActions;
    runs.current = { id: session.state.run, points: toPoints(session.state.history, session.state.total) };
    runs.previous = session.state.previous
      ? { points: toPoints(session.state.previous.points, session.state.previous.total) } : null;
    stats = null;
    applySnapshot(session.state);
    renderDemand(session.state.demand);
    showSliders();
    renderSchedule();
    renderRoadActions();
  } finally {
    guideLoading = false;
    renderGuide();
  }
  await refreshStats();
  setTab("overview");
  setMode("queues");
  renderSavedPlans();
  document.querySelector(".tab-body")!.scrollTop = 0;
  $("panel").scrollTop = 0;
  const fitted = fit([[minx, miny], [maxx, maxy]]);
  flyTo({ longitude: fitted.longitude, latitude: fitted.latitude, zoom: fitted.zoom });
}
const welcome = $<HTMLDialogElement>("welcome");
$("welcome-start").onclick = () => welcome.close();
welcome.showModal();

$("view-tour").onclick = () => setExperience("tour");
$("view-explore").onclick = () => setExperience("explore");

$("guide-next").onclick = async () => {
  if (guideStage === 2 && guideResults.length === 3) { await setExperience("explore"); return; }
  guideStage = guideStage === null ? 0 : guideStage === 0 ? 1 : 2;
  if (guideStage === 0) guideResults.length = 0;
  guideLoading = true;
  renderGuide();
  $<HTMLButtonElement>("guide-exit").disabled = true;
  try {
    await call({ cmd: "pause" });
    const preset = await call<{ state: State; roadActions: RoadAction[] }>({ cmd: "example", stage: guideStage });
    guideRun = preset.state.run;
    rate.value = String(preset.state.demand.rate);
    shadow.value = String(preset.state.demand.shadow);
    warning = preset.state.demand.warning;
    zonePlans = preset.state.demand.zones.map((zone) => ({ ...zone }));
    roadActions = preset.roadActions;
    showSliders();
    renderWarning();
    renderSchedule();
    renderRoadActions();
    setTab("overview");
    setMode("queues");
    const fitted = fit([[minx, miny], [maxx, maxy]]);
    flyTo({ longitude: fitted.longitude, latitude: fitted.latitude, zoom: fitted.zoom });
    await call({ cmd: "speed", steps: initial.speeds[initial.speeds.length - 1] });
    await call({ cmd: "play" });
    document.querySelector(".tab-body")!.scrollTop = 0;
    $("panel").scrollTop = 0;
  } catch (err) {
    guideStage = null;
    guideRun = null;
    toast("error", "Couldn't start the experiment", (err as Error).message);
  } finally {
    guideLoading = false;
    $<HTMLButtonElement>("guide-exit").disabled = false;
    renderGuide();
  }
};
$("guide-exit").onclick = () => setExperience("explore");

addEventListener("keydown", (e) => {
  if (welcome.open) return;
  if (e.target instanceof HTMLElement && e.target.closest("input, select, button, summary, a")) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  if (e.key === "r" && !e.metaKey && !e.ctrlKey && experience === "explore") resetRun();
});

const narrow = matchMedia("(max-width: 760px)");
const placeLegend = () => { $<HTMLDetailsElement>("map-key").open = !narrow.matches; };
narrow.addEventListener("change", () => {
  placeLegend();
  const fitted = fit([[minx, miny], [maxx, maxy]]);
  flyTo({ longitude: fitted.longitude, latitude: fitted.latitude, zoom: fitted.zoom });
});
placeLegend();

for (const k of COUNTER_KEYS) counters[k].set(initial.counts[k], { instant: true });
applySnapshot(initial);
renderWarning();
setMode("queues");
setTab("overview");
renderDemand(initial.demand);
renderSchedule();
renderRoadActions();
renderGuide();
await refreshStats();
addEventListener("resize", () => { renderSpeed(snap.speed); renderWarning(); setMode(mode); setTab(activeTab); });

$("loader").classList.add("gone");
