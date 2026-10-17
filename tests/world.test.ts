import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { World, type NetworkJson } from "../src/world.ts";

test("guided comparison uses consistent demand and resets closures and schedules", () => {
  const meta: NetworkJson = JSON.parse(readFileSync(new URL("../public/data/network.json", import.meta.url), "utf8"));
  const bytes = readFileSync(new URL("../public/data/network.bin", import.meta.url));
  const world = new World(meta, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const crossings = world.floodedBridges();
  assert.ok(crossings.length > 0);
  const finish = () => {
    world.speed = 12;
    world.play();
    for (let tick = 0; world.running && tick < 720; tick++) {
      world.tick();
      const counts = world.sim.counts();
      assert.equal(counts.waiting + counts.on_road + counts.evacuated + counts.stranded, world.nCars);
    }
    assert.equal(world.sim.done(), true, "the example must finish within twelve simulated hours");
    return world.summary();
  };

  world.setSegments([crossings[0]], true);
  world.loadExample(0);
  assert.equal(world.closedSegments().length, 0);
  assert.equal(world.roadActions.length, 0);
  const baseline = finish();

  world.loadExample(1);
  assert.deepEqual(world.previous?.summary, baseline);
  assert.deepEqual(world.roadActions.map((action) => action.segment), crossings);
  assert.ok(world.roadActions.every((action) => action.startsAtS === 1800 && action.kind === "close"));
  assert.ok(world.zones.every((zone) => zone.orderTimeS === 0));
  assert.equal(world.closedSegments().length, 0);
  world.speed = 1;
  world.play();
  while (world.sim.t < 1800) world.tick();
  assert.equal(world.closedSegments().length, 0);
  world.tick();
  assert.deepEqual(world.closedSegments(), crossings);
  const closures = finish();

  world.loadExample(2);
  assert.deepEqual(world.previous?.summary, closures);
  assert.equal(world.closedSegments().length, 0);
  assert.deepEqual([...new Set(world.zones.map((zone) => zone.orderTimeS))].sort((a, b) => a - b), [0, 900, 1800, 2700]);
  const staggered = finish();
  for (const summary of [closures, staggered]) {
    assert.equal(summary.cars, baseline.cars);
    assert.equal(summary.shadow_cars, baseline.shadow_cars);
    assert.equal(summary.evacuated + summary.stranded, summary.cars);
    assert.equal(summary.closed, crossings.length);
  }

  world.loadExample(0);
  assert.ok(world.zones.every((zone) => zone.orderTimeS === 0));
  assert.deepEqual(finish(), baseline, "restarting must reproduce the baseline after scheduled closures");
});
