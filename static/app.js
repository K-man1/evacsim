import { countUp, clickSpark } from "/static/bits.js";

const { Deck, TileLayer, BitmapLayer, PathLayer, GeoJsonLayer, ScatterplotLayer, PathStyleExtension,
  WebMercatorViewport, FlyToInterpolator } = deck;

const FLAG_BRIDGE = 1, FLAG_FLOODED = 2;
const ROAD_STYLE = {
  motorway: [[74, 74, 74], 2.2], trunk: [[68, 68, 68], 2], primary: [[60, 60, 60], 1.8],
  secondary: [[52, 52, 52], 1.4], tertiary: [[44, 44, 44], 1.1],
};
const LOCAL_STYLE = [[34, 34, 34], 0.8];
// Single-hue ordinal ramp validated against the dark map surface (dataviz validate_palette --ordinal).
const RAMP = [[138, 58, 18], [201, 83, 29], [240, 122, 60], [255, 185, 140]];
const CRITICAL = [208, 59, 59];
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const minutes = (m) => (m == null ? "—" : m < 10 ? m.toFixed(1) : String(Math.round(m)));

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const json = await r.json();
  if (!r.ok) throw new Error(json.error ?? r.statusText);
  return json;
}

const [network, flood, district, towns, initial] = await Promise.all(
  ["/network", "/flood", "/district", "/towns", "/state"].map((p) => fetch(p).then((r) => r.json())),
);

const roads = network.paths.map((path, i) => ({
  i, path, cls: network.classes[i], name: network.names[i], flags: network.flags[i],
  storage: network.storage[i], town: network.town[i],
}));
const townNames = network.towns;
// "Manville borough" reads as "Manville", except where a borough and a township share a name (Hopewell).
const baseName = (n) => n.replace(/ (township|borough|city)$/, "");
const baseCounts = townNames.reduce((m, n) => m.set(baseName(n), (m.get(baseName(n)) ?? 0) + 1), new Map());
const shortTown = (k) => (baseCounts.get(baseName(townNames[k])) > 1 ? townNames[k] : baseName(townNames[k]));
const floodedBridges = roads.filter((r) => (r.flags & FLAG_BRIDGE) && (r.flags & FLAG_FLOODED)).map((r) => r.i);
const roadLabel = (r) => r.name || `Unnamed ${r.cls.replace("_", " ")}`;

// Live state from the SSE stream (10 Hz) and the heavier /stats endpoint (polled at 1 Hz while running).
const load = new Float32Array(roads.length);
const queued = new Int32Array(roads.length);
const delayMin = new Float32Array(roads.length);
const flow = new Float32Array(roads.length);
let busy = [];
let delayed = [];
let routed = [];
let maxDelay = 1, maxFlow = 1;
let closed = new Set(initial.closed);
let snap = initial;
let stats = null;
let mode = "queues";
let activeTab = "overview";
let hovered = null;
let selectedSeg = null;
let selectedTown = null;
let flash = { segs: [], on: false };
let version = 0;

const tooltip = $("tooltip");
const spark = clickSpark($("sparks"));

function rampColor(x) {
  const t = Math.min(1, Math.max(0, x)) * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(t));
  const f = t - i;
  return RAMP[i].map((c, k) => Math.round(c + (RAMP[i + 1][k] - c) * f));
}

// Delay and route counts span several orders of magnitude; a log scale keeps the small ones visible.
const logShare = (v, max) => Math.log1p(v) / Math.log1p(max);

function heatLayer() {
  const [data, value] = {
    queues: [busy, (i) => load[i]],
    delay: [delayed, (i) => logShare(delayMin[i], maxDelay)],
    routes: [routed, (i) => logShare(flow[i], maxFlow)],
  }[mode];
  return new PathLayer({
    id: `heat-${mode}`, data, widthUnits: "pixels", capRounded: true, jointRounded: true,
    getPath: (i) => roads[i].path,
    getColor: (i) => rampColor(value(i)),
    getWidth: (i) => 1.4 + 3.6 * value(i),
    updateTriggers: { getColor: version, getWidth: version },
  });
}

function tiles(id, url, bitmapProps) {
  return new TileLayer({
    id, data: url, minZoom: 0, maxZoom: 16, tileSize: 256,
    renderSubLayers: (props) => {
      const { west, south, east, north } = props.tile.bbox;
      return new BitmapLayer(props, { data: null, image: props.data, bounds: [west, south, east, north], ...bitmapProps });
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
      getFillColor: (f, { index }) => (index === selectedTown ? [255, 255, 255, 12] : [0, 0, 0, 0]),
      getLineColor: (f, { index }) => (index === selectedTown ? [255, 255, 255, 200] : [255, 255, 255, activeTab === "towns" ? 50 : 0]),
      getLineWidth: (f, { index }) => (index === selectedTown ? 2 : 1), lineWidthUnits: "pixels",
      updateTriggers: { getFillColor: selectedTown, getLineColor: [selectedTown, activeTab], getLineWidth: selectedTown },
    }),
    new GeoJsonLayer({
      id: "district", data: district, filled: false, stroked: true,
      getLineColor: [255, 255, 255, 110], lineWidthMinPixels: 1,
      getDashArray: [4, 4], dashJustified: true, extensions: [new PathStyleExtension({ dash: true })],
    }),
    new PathLayer({
      id: "roads", data: roads, pickable: true, autoHighlight: true, highlightColor: [255, 255, 255, 90],
      widthUnits: "pixels", capRounded: true, jointRounded: true,
      getPath: (r) => r.path,
      getColor: (r) => (ROAD_STYLE[r.cls] ?? LOCAL_STYLE)[0],
      getWidth: (r) => (ROAD_STYLE[r.cls] ?? LOCAL_STYLE)[1],
    }),
    heatLayer(),
    new PathLayer({
      id: "closed", data: [...closed], widthUnits: "pixels",
      getPath: (i) => roads[i].path,
      // Fresh closures land white and wide, then ease down to the dashed red closure style.
      getColor: (i) => (flashSet.has(i) ? [255, 255, 255] : CRITICAL),
      getWidth: (i) => (flashSet.has(i) ? 10 : 3),
      getDashArray: [3, 2], dashJustified: true, extensions: [new PathStyleExtension({ dash: true })],
      transitions: { getWidth: { duration: 700, easing: (t) => 1 - (1 - t) ** 3 }, getColor: 700 },
      updateTriggers: { getColor: [flash.on, flash.segs], getWidth: [flash.on, flash.segs] },
    }),
    new PathLayer({
      id: "selected", data: selectedSeg == null ? [] : [selectedSeg], widthUnits: "pixels",
      getPath: (i) => roads[i].path, getColor: [255, 255, 255], getWidth: 6, capRounded: true, jointRounded: true,
    }),
    new ScatterplotLayer({
      id: "stranded", data: stats?.stranded ?? [], radiusUnits: "pixels", stroked: true, pickable: true,
      getPosition: (p) => [p[0], p[1]], getRadius: (p) => 4 + Math.min(10, Math.sqrt(p[2])),
      getFillColor: CRITICAL, getLineColor: [255, 255, 255], lineWidthMinPixels: 1.5,
      updateTriggers: { getRadius: version },
    }),
    tiles("labels", `${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { opacity: 0.6 }),
  ];
}

const panelWidth = () => (innerWidth > 760 ? 400 : 0);
const [minx, miny, maxx, maxy] = network.bounds;

function fit(bounds, extra = {}) {
  // fitBounds asserts if padding exceeds the viewport, which happens in a small window.
  const w = Math.max(innerWidth, 100), h = Math.max(innerHeight, 100);
  const padRight = Math.min(40 + panelWidth(), w * 0.45);
  const padLeft = innerWidth > 760 ? Math.min(330, w * 0.3) : Math.min(20, w * 0.05);
  const pad = Math.min(70, h * 0.2);
  // On a phone the panel covers the bottom ~55% and the header stack the top 130px.
  const top = innerWidth > 760 ? pad : Math.min(130, h * 0.2);
  const bottom = innerWidth > 760 ? pad : Math.min(h * 0.57, h - top - 60);
  return new WebMercatorViewport({ width: w, height: h }).fitBounds(bounds, {
    padding: { top, bottom, left: padLeft, right: padRight }, ...extra,
  });
}

const start = fit([[minx, miny], [maxx, maxy]]);
let viewState = { longitude: start.longitude, latitude: start.latitude, zoom: start.zoom, pitch: 0, bearing: 0 };

const map = new Deck({
  parent: $("map"),
  viewState,
  controller: { dragRotate: false, touchRotate: false },
  onViewStateChange: ({ viewState: next }) => { viewState = next; map.setProps({ viewState }); },
  layers: layers(),
  getCursor: ({ isDragging, isHovering }) => (isDragging ? "grabbing" : isHovering ? "pointer" : "grab"),
  onHover: (info) => { hovered = info.object ? info : null; renderTooltip(); },
  onClick: toggleRoad,
});
const redraw = () => map.setProps({ layers: layers() });

function flyTo(target) {
  viewState = { ...viewState, ...target, transitionDuration: 900, transitionInterpolator: new FlyToInterpolator() };
  map.setProps({ viewState });
}

// Center a point in the part of the map not covered by the panels, not the middle of the window.
function centerOn(longitude, latitude, zoom) {
  const w = innerWidth, h = innerHeight;
  const wide = w > 760;
  const cx = wide ? (Math.min(330, w * 0.3) + (w - panelWidth())) / 2 : w / 2;
  const cy = wide ? h / 2 : (130 + h * 0.45) / 2;
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
  if (layer.id === "stranded") {
    const [, , count, town] = object;
    tooltip.innerHTML = `<h3>${fmt(count)} stranded car${count === 1 ? "" : "s"}</h3>
      <div class="where">${escapeHtml(townNames[town])}</div>
      <div>Every route from here to dry ground crosses a closed road.</div>`;
  } else {
    const r = object;
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
      <div class="act">Click to ${isClosed ? "reopen" : "close"} this road</div>`;
  }
  const pad = 14;
  const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
  tooltip.style.left = `${Math.min(x + pad, innerWidth - w - pad)}px`;
  tooltip.style.top = `${y + pad + h > innerHeight ? y - h - pad : y + pad}px`;
  tooltip.classList.add("show");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Toasts

const ICONS = {
  closed: '<svg viewBox="0 0 16 16" fill="none" stroke="#f08a8a" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  open: '<svg viewBox="0 0 16 16" fill="none" stroke="#ededed" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5 6.5 12 13 4.5"/></svg>',
  error: '<svg viewBox="0 0 16 16" fill="#d03b3b"><path d="M8 1.5 15 14H1L8 1.5zm-.75 4.5v4h1.5V6h-1.5zm0 5v1.5h1.5V11h-1.5z"/></svg>',
};

function toast(kind, title, detail = "") {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `${ICONS[kind]}<span>${escapeHtml(title)}</span>${detail ? `<span class="t-detail">${escapeHtml(detail)}</span>` : ""}`;
  $("toasts").append(el);
  setTimeout(() => { el.classList.add("out"); el.addEventListener("animationend", () => el.remove()); }, 3600);
}

function flashSegments(segs) {
  flash = { segs, on: true };
  redraw();
  // Render one frame wide and white, then let the layer's transition ease it to the closed style.
  requestAnimationFrame(() => requestAnimationFrame(() => { flash = { segs, on: false }; redraw(); }));
}

const rerouted = (n) => (n ? `${fmt(n)} driver${n === 1 ? "" : "s"} rerouted` : "no current routes used it");

async function toggleRoad({ object, x, y, layer }) {
  if (!object || layer.id !== "roads") return;
  const closing = !closed.has(object.i);
  spark(x, y, closing ? "#d03b3b" : "#ededed");
  closing ? closed.add(object.i) : closed.delete(object.i);
  if (closing) flashSegments([object.i]);
  else redraw();
  renderTooltip();
  renderBridgeButton();
  try {
    const result = await post(closing ? "/close" : "/open", { seg: object.i });
    toast(closing ? "closed" : "open", `${closing ? "Closed" : "Reopened"} ${roadLabel(object)}`,
      closing ? rerouted(result.affected) : "");
    refreshStats();
  } catch (err) {
    toast("error", "Couldn't update the road", err.message);
  }
}

// Flooded-bridges toggle

const bridgeBtn = $("close-bridges");
let bridgeBusy = false;

function renderBridgeButton() {
  if (bridgeBusy) return;
  const n = floodedBridges.length;
  const allClosed = floodedBridges.every((i) => closed.has(i));
  bridgeBtn.dataset.state = allClosed ? "closed" : "idle";
  $("bridge-title").textContent = allClosed ? `${n} flooded bridges closed` : `Close ${n} flooded bridges`;
  $("bridge-sub").textContent = allClosed ? "Click to reopen them" : "Simulates the rivers rising";
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
      post(closing ? "/close" : "/open", { segs: floodedBridges }),
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
    toast(closing ? "closed" : "open", `${closing ? "Closed" : "Reopened"} ${fmt(result.changed)} flooded bridges`,
      closing ? rerouted(result.affected) : "");
    refreshStats();
  } catch (err) {
    bridgeBusy = false;
    renderBridgeButton();
    toast("error", "Couldn't change the bridges", err.message);
  }
};

$("open-all").onclick = async () => {
  const n = closed.size;
  if (!n) return;
  await post("/open-all");
  toast("open", `Reopened ${fmt(n)} road${n === 1 ? "" : "s"}`);
  refreshStats();
};

// Clock, counters, chart

const counters = Object.fromEntries(
  ["evacuated", "on_road", "waiting", "stranded"].map((k) => [k, countUp($(`n-${k}`))]),
);
const toPoints = (history, total) => history.map(([t, n]) => ({ t, pct: (100 * n) / total }));
const runs = {
  current: { id: initial.run, points: toPoints(initial.history, initial.total) },
  previous: initial.previous && {
    points: toPoints(initial.previous.points, initial.previous.total),
  },
};

function fmtClock(t) {
  const s = Math.floor(t);
  return [s / 3600, (s % 3600) / 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, "0")).join(":");
}

function applySnapshot(s) {
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

  for (const [k, c] of Object.entries(counters)) c.set(s.counts[k]);
  $("stranded-tile").dataset.alert = String(s.counts.stranded > 0);
  $("clock").textContent = fmtClock(s.t);
  $("pct").textContent = `${Math.floor(pct)}% out`;
  $("progress").style.width = `${pct}%`;
  $("closed-count").textContent = `${fmt(closed.size)} road${closed.size === 1 ? "" : "s"} closed`;
  $("closed-count").classList.toggle("active", closed.size > 0);

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
  if (activeTab === "overview") renderChart(chartHover);
  redraw();
  if (hovered) renderTooltip();
  if (newRun || justFinished) refreshStats();
}

function renderResult() {
  const el = $("result");
  const sum = stats?.summary;
  if (!snap.done || !sum || stats.run !== snap.run) {
    el.classList.remove("show");
    return;
  }
  let html = `90% out by <strong>${minutes(sum.t90_min)} min</strong>`;
  if (sum.cleared_min != null) html += ` · last at ${Math.round(sum.cleared_min)} min`;
  if (sum.stranded) html += ` · <strong>${fmt(sum.stranded)}</strong> stranded`;
  if (sum.worst_road) html += ` · worst jam on <strong>${escapeHtml(sum.worst_road)}</strong>`;
  $("result-text").innerHTML = html;
  el.classList.add("show");
}

const chart = $("chart");
const chartTip = $("chart-tip");
const M = { top: 8, right: 34, bottom: 18, left: 30 };
let chartHover = null;

function renderChart(hoverX = null) {
  const w = chart.clientWidth, h = chart.clientHeight;
  if (!w) return;
  const iw = w - M.left - M.right, ih = h - M.top - M.bottom;
  const all = [runs.current, runs.previous].filter(Boolean);
  const tMax = Math.max(3600, ...all.flatMap((r) => r.points.map((p) => p.t))) * 1.02;
  const xs = (t) => M.left + (t / tMax) * iw;
  const ys = (p) => M.top + ih - (p / 100) * ih;
  const line = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${xs(p.t).toFixed(1)},${ys(p.pct).toFixed(1)}`).join("");

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
    const at = (pts) => pts.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best), pts[0]);
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
    chartTip.style.opacity = 1;
  } else {
    chartTip.style.opacity = 0;
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
  try {
    stats = await fetch("/stats").then((r) => r.json());
  } finally {
    statsInFlight = false;
  }
  delayMin.fill(0);
  flow.fill(0);
  stats.delay.segs.forEach((seg, k) => { delayMin[seg] = stats.delay.veh_min[k]; });
  stats.flow.segs.forEach((seg, k) => { flow[seg] = stats.flow.cars[k]; });
  delayed = stats.delay.segs;
  routed = stats.flow.segs;
  maxDelay = stats.delay.veh_min.reduce((a, b) => Math.max(a, b), 1);
  maxFlow = stats.flow.cars.reduce((a, b) => Math.max(a, b), 1);
  version++;

  renderDemand(stats.demand);
  if (stats.demand.warning !== warning) { warning = stats.demand.warning; renderWarning(); }
  const sum = stats.summary;
  const tile = (v, unit) => (v == null ? "—" : `${unit === "veh-h" ? fmt(v) : minutes(v)}<small>${unit}</small>`);
  $("m-t90").innerHTML = tile(sum.t90_min, "min");
  $("m-last").innerHTML = tile(sum.cleared_min, "min");
  $("m-stranded").innerHTML = sum.stranded_all > sum.stranded
    ? `${fmt(sum.stranded)}<small>+${fmt(sum.stranded_all - sum.stranded)} neighbors</small>` : fmt(sum.stranded);
  $("m-median").innerHTML = tile(sum.median_min, "min");
  $("m-delay").innerHTML = tile(sum.mean_delay_min, "min");
  $("m-vh").innerHTML = tile(sum.delay_veh_h, "veh-h");
  $("compare-badge").hidden = !stats.previous;

  renderLegend();
  renderResult();
  if (activeTab === "bottlenecks") renderBottlenecks();
  if (activeTab === "towns") renderTowns();
  if (activeTab === "compare") renderCompare();
  redraw();
}
setInterval(() => { if (snap.running) refreshStats(); }, 1000);

function renderDemand(d) {
  $("d-people").textContent = fmt(d.people);
  $("d-households").textContent = fmt(d.households);
  $("d-cars").innerHTML = d.shadow_cars ? `${fmt(d.cars)}<small>+${fmt(d.shadow_cars)} nbrs</small>` : fmt(d.cars);
  $("d-novehicle").innerHTML = `${fmt(d.no_vehicle)}<small>households</small>`;
  $("d-note").innerHTML = `<strong>${fmt(d.no_vehicle_people)}</strong> people live in flood-zone households with no vehicle. `
    + `They aren't in the traffic sim and need buses or rides out. One car per household with a vehicle.`;
  $("rate-sub").textContent = `${fmt(d.cars)} cars, one per household with a vehicle`;
  $("shadow-sub").textContent = `${fmt(d.shadow_cars)} cars from ${fmt(d.shadow_households)} households within 200 m`;
}

function renderBottlenecks() {
  const list = $("bottlenecks");
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
    return `<div class="list-row" tabindex="0" style="--k:${k}" data-seg="${b.seg}" aria-current="${b.seg === selectedSeg}">
      <span class="rank">${k + 1}</span>
      <div class="row-main">
        <div class="row-title">${escapeHtml(roadLabel(r))}</div>
        <div class="row-sub">${escapeHtml(townNames[b.town])} ${tags}</div>
        <div class="bar"><i style="width:${(100 * b.delay_veh_h) / top}%"></i></div>
      </div>
      <div class="row-val"><b>${b.delay_veh_h.toFixed(1)} veh-h</b><span>${fmt(b.queued)} queued · ${fmt(b.flow)} routed</span></div>
    </div>`;
  }).join("");
  for (const row of list.querySelectorAll(".list-row")) {
    const go = () => focusSegment(Number(row.dataset.seg));
    row.onclick = go;
    row.onkeydown = (e) => { if (e.key === "Enter") go(); };
  }
}

function focusSegment(seg) {
  selectedSeg = selectedSeg === seg ? null : seg;
  if (selectedSeg != null) {
    const b = stats.bottlenecks.find((x) => x.seg === seg);
    centerOn(b.at[0], b.at[1], 15.5);
    if (mode !== "delay") setMode("delay");
  }
  renderBottlenecks();
  redraw();
}

let townSort = "risk";
function renderTowns() {
  const body = $("towns").querySelector("tbody");
  const rows = [...(stats?.towns ?? [])];
  const share = (t) => (t.cars ? t.evacuated / t.cars : 1);
  const sorters = {
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
  for (const btn of $("towns").querySelectorAll("th button")) btn.setAttribute("aria-pressed", String(btn.dataset.sort === townSort));
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
  for (const tr of body.querySelectorAll("tr")) {
    const go = () => focusTown(Number(tr.dataset.town));
    tr.onclick = go;
    tr.onkeydown = (e) => { if (e.key === "Enter") go(); };
  }
}

for (const btn of $("towns").querySelectorAll("th button")) {
  btn.onclick = () => { townSort = townSort === btn.dataset.sort ? "risk" : btn.dataset.sort; renderTowns(); };
}

function focusTown(k) {
  selectedTown = selectedTown === k ? null : k;
  const feature = towns.features[k];
  if (selectedTown != null && feature) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const walk = (c) => {
      if (typeof c[0] !== "number") return c.forEach(walk);
      x0 = Math.min(x0, c[0]); y0 = Math.min(y0, c[1]); x1 = Math.max(x1, c[0]); y1 = Math.max(y1, c[1]);
    };
    walk(feature.geometry.coordinates);
    const v = fit([[x0, y0], [x1, y1]], { maxZoom: 15 });
    flyTo({ longitude: v.longitude, latitude: v.latitude, zoom: v.zoom });
  }
  renderTowns();
  redraw();
}

// [label, summary key, unit, which direction is better: -1 lower, 0 neutral]
const COMPARE_ROWS = [
  ["50% out by", "t50_min", "min", -1],
  ["90% out by", "t90_min", "min", -1],
  ["Last one out", "cleared_min", "min", -1],
  ["Stranded, flood zone", "stranded", "cars", -1],
  ["Stranded, all", "stranded_all", "cars", -1],
  ["Median trip", "median_min", "min", -1],
  ["90th pct trip", "p90_min", "min", -1],
  ["Avg delay per car", "mean_delay_min", "min", -1],
  ["Total delay", "delay_veh_h", "veh-h", -1],
  ["Roads closed", "closed", "", 0],
  ["Households leaving", "rate", "%", 0],
  ["Neighbors leaving", "shadow", "%", 0],
  ["Flood-zone cars", "cars", "", 0],
  ["Neighbor cars", "shadow_cars", "", 0],
];
const WARNING_LABEL = { sudden: "Sudden", short: "Hours", long: "A day" };
const ARROW_UP = '<svg viewBox="0 0 10 10" fill="currentColor"><path d="M5 1 9.5 8h-9z"/></svg>';
const ARROW_DOWN = '<svg viewBox="0 0 10 10" fill="currentColor"><path d="M5 9 .5 2h9z"/></svg>';

function renderCompare() {
  const cur = stats?.summary, prev = stats?.previous;
  $("compare-empty").hidden = !!prev;
  $("compare").hidden = !prev;
  if (!prev) return;
  const show = (v, unit) => (v == null ? '<span class="dim">—</span>' : unit === "min" ? minutes(v) : fmt(v));
  const rows = COMPARE_ROWS.map(([label, key, unit, better]) => {
    const a = cur[key], b = prev[key];
    let change = '<span class="dim">—</span>';
    if (a != null && b != null) {
      const d = a - b;
      if (Math.abs(d) < 0.05) {
        change = '<span class="dim">same</span>';
      } else {
        const tone = better === 0 ? "" : Math.sign(d) === better ? "better" : "worse";
        const size = unit === "min" ? Math.abs(d).toFixed(1) : fmt(Math.abs(d));
        change = `<span class="delta ${tone}">${d > 0 ? ARROW_UP : ARROW_DOWN}${d > 0 ? "+" : "−"}${size}</span>`;
      }
    }
    return `<tr><td>${label}${unit ? ` <span class="dim">${unit}</span>` : ""}</td>
      <td class="r num">${show(a, unit)}</td><td class="r num">${show(b, unit)}</td><td class="r">${change}</td></tr>`;
  });
  const road = (v) => `<td class="r text" title="${escapeHtml(v ?? "")}">${escapeHtml(v ?? "—")}</td>`;
  rows.push(`<tr><td>Warning time</td><td class="r">${WARNING_LABEL[cur.warning]}</td><td class="r">${WARNING_LABEL[prev.warning] ?? "—"}</td><td></td></tr>`);
  rows.push(`<tr><td>Worst bottleneck</td>${road(cur.worst_road)}${road(prev.worst_road)}<td></td></tr>`);
  $("compare").querySelector("tbody").innerHTML = rows.join("");
}

// Map layer switch and legend

const LEGENDS = {
  queues: ["Road load, queue ÷ capacity", () => "Light", () => "Jammed"],
  delay: ["Delay caused, vehicle-minutes (log)", () => "1", () => fmt(maxDelay)],
  routes: ["Cars routed through, current plan (log)", () => "1", () => fmt(maxFlow)],
};

function renderLegend() {
  const [title, lo, hi] = LEGENDS[mode];
  $("legend-title").textContent = title;
  $("legend-lo").textContent = lo();
  $("legend-hi").textContent = hi();
}

function placeThumb(seg, active) {
  const thumb = seg.querySelector(".thumb");
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.transform = `translateX(${active.offsetLeft}px)`;
}

function setMode(next) {
  mode = next;
  const buttons = [...$("modes").querySelectorAll("button")];
  buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  placeThumb($("modes"), buttons.find((b) => b.dataset.mode === mode));
  renderLegend();
  redraw();
}
for (const b of $("modes").querySelectorAll("button")) b.onclick = () => setMode(b.dataset.mode);

// Tabs

function setTab(name) {
  activeTab = name;
  const buttons = [...$("tabbar").querySelectorAll("button")];
  buttons.forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  const btn = buttons.find((b) => b.dataset.tab === name);
  const line = $("tabbar").querySelector(".underline");
  line.style.width = `${btn.offsetWidth - 20}px`;
  line.style.transform = `translateX(${btn.offsetLeft + 10}px)`;
  for (const p of document.querySelectorAll(".tab-panel")) p.hidden = p.dataset.panel !== name;
  if (name !== "towns") selectedTown = null;
  if (name !== "bottlenecks") selectedSeg = null;
  if (name === "overview") renderChart();
  if (name === "bottlenecks") renderBottlenecks();
  if (name === "towns") renderTowns();
  if (name === "compare") renderCompare();
  redraw();
}
for (const b of $("tabbar").querySelectorAll("button")) b.onclick = () => setTab(b.dataset.tab);

// Run controls

const speedSeg = $("speed");
for (const steps of initial.speeds) {
  const b = document.createElement("button");
  b.textContent = `${Math.round((steps * 5) / 0.1)}×`;
  b.title = `${((steps * 5) / 0.1 / 60).toFixed(1)} sim-minutes per second`;
  b.dataset.steps = steps;
  b.onclick = () => post("/speed", { steps });
  speedSeg.append(b);
}
function renderSpeed(steps) {
  const buttons = [...speedSeg.querySelectorAll("button")];
  const active = buttons.find((b) => Number(b.dataset.steps) === steps);
  buttons.forEach((b) => b.setAttribute("aria-pressed", String(b === active)));
  placeThumb(speedSeg, active);
}

const rate = $("rate");
const shadow = $("shadow");
let warning = initial.demand.warning;
const togglePlay = () => post(snap.running ? "/pause" : "/play");
const resetRun = () => post("/reset", { rate: Number(rate.value), shadow: Number(shadow.value), warning });
const changeScenario = async () => { await resetRun(); refreshStats(); };
$("play").onclick = togglePlay;
$("reset").onclick = resetRun;

rate.value = initial.demand.rate;
shadow.value = initial.demand.shadow;
const showSliders = () => {
  $("rate-val").textContent = `${rate.value}%`;
  $("shadow-val").textContent = `${shadow.value}%`;
};
showSliders();
rate.oninput = shadow.oninput = showSliders;
rate.onchange = shadow.onchange = changeScenario;

const warningSeg = $("warning");
function renderWarning() {
  const buttons = [...warningSeg.querySelectorAll("button")];
  buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.warning === warning)));
  placeThumb(warningSeg, buttons.find((b) => b.dataset.warning === warning));
}
for (const b of warningSeg.querySelectorAll("button")) {
  b.onclick = () => { warning = b.dataset.warning; renderWarning(); changeScenario(); };
}

addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  if (e.key === "r" && !e.metaKey && !e.ctrlKey) resetRun();
});

// On a phone the dock can't float beside the panel, so it joins the panel's scroll.
const narrow = matchMedia("(max-width: 760px)");
const placeDock = () => (narrow.matches ? document.querySelector(".tab-body") : document.body).append($("dock"));
narrow.addEventListener("change", placeDock);
placeDock();

for (const [k, c] of Object.entries(counters)) c.set(initial.counts[k], { instant: true });
applySnapshot(initial);
renderWarning();
setMode("queues");
setTab("overview");
renderDemand(initial.demand);
await refreshStats();
const events = new EventSource("/stream");
events.onmessage = (e) => applySnapshot(JSON.parse(e.data));
addEventListener("resize", () => { renderSpeed(snap.speed); renderWarning(); setMode(mode); setTab(activeTab); });

$("loader").classList.add("gone");
