import assert from "node:assert/strict";
import { createGeometryCache } from "./display-list-geometry.mjs";
import { createAssetTracker } from "./display-list-data.mjs";
function attribute(data, dimensions) {
  const listeners = new Set();
  const buffer = {
    buffer: data.buffer,
    stride: dimensions * 4,
    addAbstraction: (r) => listeners.add(r),
    removeAbstraction: (r) => listeners.delete(r),
  };
  return {
    attributesBuffer: buffer,
    offset: 0,
    dimensions,
    size: 4,
    count: data.length / dimensions,
    invalidate() {
      for (const r of listeners) r.onInvalidate();
    },
  };
}
const positions = attribute(
  new Float32Array([0, 0, 10, 0, 10, 10, 0, 0, 10, 10, 0, 10]),
  2,
);
const shape = {
  elements: {
    assetType: "[asset TriangleElements]",
    positions,
    numVertices: 6,
  },
  count: 0,
  offset: 0,
};
const stats = { geometryBuilds: 0 },
  tracker = createAssetTracker();
const cache = createGeometryCache(tracker, stats);
const a = cache.sync(null, shape, null, false);
const b = cache.sync(null, { ...shape }, null, false);
assert.equal(a.geometry, b.geometry);
assert.equal(stats.geometryBuilds, 1);
assert.equal(stats.geometryUsers, 2);
assert.equal(stats.geometryShares, 1);
for (let i = 0; i < 10; i++) assert.equal(cache.sync(a, shape, null, false), a);
assert.equal(stats.geometryBuilds, 1, "unchanged data is not rebuilt");
const uv = { a: 2, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
const mapped = cache.sync(null, shape, uv, false);
const range = cache.sync(null, { ...shape, count: 3 }, null, false);
const custom = cache.sync(null, shape, null, true);
assert.notEqual(mapped.geometry, a.geometry);
assert.notEqual(range.geometry, a.geometry);
assert.notEqual(custom.geometry, a.geometry);
assert.equal(mapped.geometry.uvs[2], 20);
assert.equal(range.geometry.indices.length, 3);
new Float32Array(positions.attributesBuffer.buffer)[2] = 20;
positions.invalidate();
const builds = stats.geometryBuilds;
cache.sync(a, shape, null, false);
cache.sync(b, shape, null, false);
assert.equal(stats.geometryBuilds, builds + 1, "shared edits convert once");
assert.equal(b.geometry.positions[2], 20);
let destroyed = 0;
a.geometry.on("destroy", () => destroyed++);
cache.release(a);
cache.sweep();
assert.equal(destroyed, 0, "removing one user keeps the geometry alive");
// Re-registering an asset after tracker retirement must not match an old revision.
tracker.epoch = 10;
tracker.sweep();
new Float32Array(positions.attributesBuffer.buffer)[2] = 30;
cache.sync(b, shape, null, false);
assert.equal(b.geometry.positions[2], 30);
cache.release(b);
cache.sweep();
assert.equal(destroyed, 1);
cache.release(mapped);
cache.release(range);
cache.release(custom);
cache.sweep();
assert.equal(stats.geometryUsers, 0);
assert.equal(stats.geometryEntries, 0);
cache.destroy();
tracker.destroy();
console.log(
  "Shared geometry: reuse, UV/range/layout isolation, edits, hidden assets and final-user cleanup passed.",
);
