// Runs the simulation off the main thread so a reroute never stalls map panning. Replaces the Flask server:
// each request from the page is a former endpoint, and snapshots replace the SSE stream.
import { World, TICK_S, type NetworkJson } from "./world.ts";
import type { Warning } from "./sim.ts";

export type Command =
  | { cmd: "state" }
  | { cmd: "stats" }
  | { cmd: "close" | "open"; segs: number[] }
  | { cmd: "closeFloodedBridges" | "openAll" | "play" | "pause" }
  | { cmd: "speed"; steps: number }
  | { cmd: "reset"; rate?: number; shadow?: number; warning?: Warning };

export type FromWorker =
  | { type: "reply"; id: number; result?: unknown; error?: string }
  | { type: "snapshot"; snapshot: ReturnType<World["snapshot"]> };

const [meta, bin] = await Promise.all([
  fetch("/data/network.json").then((r) => r.json() as Promise<NetworkJson>),
  fetch("/data/network.bin").then((r) => r.arrayBuffer()),
]);
const world = new World(meta, bin);

const send = (msg: FromWorker) => postMessage(msg);
const publish = () => send({ type: "snapshot", snapshot: world.snapshot() });

function handle(c: Command): unknown {
  switch (c.cmd) {
    case "state":
      return world.state();
    case "stats":
      return world.stats();
  }
  const result = mutate(c);
  world.publish();
  publish();
  return result ?? { ok: true };
}

function mutate(c: Exclude<Command, { cmd: "state" | "stats" }>) {
  switch (c.cmd) {
    case "close":
    case "open":
      return world.setSegments(c.segs, c.cmd === "close");
    case "closeFloodedBridges":
      return world.setSegments(world.floodedBridges(), true);
    case "openAll":
      return world.setSegments(world.closedSegments(), false);
    case "play":
      return world.play();
    case "pause":
      world.running = false;
      return;
    case "speed":
      world.speed = c.steps;
      return;
    case "reset":
      return world.reset(c.rate, c.shadow, c.warning);
  }
}

onmessage = (e: MessageEvent<{ id: number } & Command>) => {
  const { id, ...command } = e.data;
  try {
    send({ type: "reply", id, result: handle(command as Command) });
  } catch (err) {
    send({ type: "reply", id, error: err instanceof Error ? err.message : String(err) });
  }
};

setInterval(() => { if (world.tick()) publish(); }, TICK_S * 1000);
// The page waits for this before sending requests: anything posted while the network loaded had no handler.
send({ type: "reply", id: 0, result: "ready" });
