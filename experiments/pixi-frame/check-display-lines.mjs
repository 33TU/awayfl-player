import assert from "node:assert/strict";
import { lineSegments, createPixelLineCache } from "./display-list-lines.mjs";
import { createAssetTracker } from "./display-list-data.mjs";
function attribute(data, dimensions) {
  const listeners = new Set();
  return {
    attributesBuffer: {
      buffer: data.buffer,
      stride: dimensions * 4,
      addAbstraction: (r) => listeners.add(r),
      removeAbstraction: (r) => listeners.delete(r),
    },
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
  new Float32Array([
    0, 0, 10, 0, 10, 0, 0, 0, 0, 0, 10, 0, 10, 0, 0, 0, 20, 0, 30, 0, 30, 0, 20,
    0, 20, 0, 30, 0, 30, 0, 20, 0,
  ]),
  4,
);
const indices = attribute(
  new Uint32Array([0, 1, 2, 3, 2, 1, 4, 5, 6, 7, 6, 5]),
  3,
);
const shape = {
  elements: { dimension: 2, positions, indices },
  offset: 0,
  count: 0,
};
assert.deepEqual(lineSegments(shape), [
  [0, 0, 10, 0],
  [20, 0, 30, 0],
]);
assert.deepEqual(lineSegments({ ...shape, offset: 2, count: 2 }), [
  [20, 0, 30, 0],
]);
assert.equal(lineSegments({ ...shape, offset: 1, count: 1 }), null);
assert.equal(lineSegments({ ...shape, count: 6 }), null);
const stats = {},
  tracker = createAssetTracker(),
  cache = createPixelLineCache(tracker, stats);
const a = cache.sync(null, shape),
  b = cache.sync(null, shape);
assert.equal(a.context, b.context);
assert.equal(stats.pixelLineBuilds, 1);
cache.sync(a, shape);
assert.equal(stats.pixelLineBuilds, 1);
new Float32Array(positions.attributesBuffer.buffer)[0] = 5;
positions.invalidate();
cache.sync(a, shape);
cache.sync(b, shape);
assert.equal(stats.pixelLineBuilds, 2);
assert.equal(a.context.instructions[0].action, "stroke");
assert.equal(a.context.instructions[0].data.style.pixelLine, true);
let destroyed = 0;
a.context.on("destroy", () => destroyed++);
cache.release(a);
cache.sweep();
assert.equal(destroyed, 0);
cache.release(b);
cache.sweep();
assert.equal(destroyed, 1);
assert.equal(stats.pixelLineEntries, 0);
cache.destroy();
tracker.destroy();
console.log(
  "Pixel lines: segment ranges, shared contexts, revision updates and lifetime passed.",
);
