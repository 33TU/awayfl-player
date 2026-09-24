import assert from "node:assert/strict";
import {
  triangleData,
  combineColor,
  createAssetTracker,
} from "./display-list-data.mjs";
const abstractions = new Map();
const buffer = {
  buffer: new ArrayBuffer(4 * 5 * 4),
  stride: 20,
  addAbstraction(r) {
    abstractions.set(r.id, r);
  },
  removeAbstraction(r) {
    abstractions.delete(r.id);
  },
};
new Float32Array(buffer.buffer).set([
  10, 20, 99, 0, 0, 30, 20, 99, 1, 0, 30, 40, 99, 1, 1, 10, 40, 99, 0, 1,
]);
const positions = {
  attributesBuffer: buffer,
  offset: 0,
  size: 4,
  dimensions: 3,
  count: 4,
};
const uvs = { ...positions, offset: 12, dimensions: 2 };
const ib = { buffer: new Uint16Array([0, 1, 2, 0, 2, 3]).buffer, stride: 6 };
const indices = {
  attributesBuffer: ib,
  offset: 0,
  size: 2,
  dimensions: 3,
  count: 2,
};
const shape = {
  elements: { assetType: "[asset TriangleElements]", positions, uvs, indices },
  count: 1,
  offset: 1,
};
const mesh = triangleData(shape, { a: 2, b: 0, c: 0, d: 3, tx: 0.25, ty: 0.5 });
assert.deepEqual([...mesh.positions], [10, 20, 30, 20, 30, 40, 10, 40]);
assert.deepEqual([...mesh.indices], [0, 2, 3]);
assert.deepEqual([...mesh.uvs], [0.25, 0.5, 2.25, 0.5, 2.25, 3.5, 0.25, 3.5]);
assert.throws(() => triangleData({ ...shape, count: 2 }), /range/);
assert.deepEqual(
  [
    ...combineColor(
      [0.5, 1, 1, 0.5, 10, 0, 0, 0],
      [0.5, 1, 1, 0.5, 20, 0, 0, 0],
    ),
  ],
  [0.25, 1, 1, 0.25, 20, 0, 0, 0],
);
const tracker = createAssetTracker();
assert.equal(tracker.version(buffer), 0);
for (const r of abstractions.values()) r.onInvalidate();
assert.equal(tracker.version(buffer), 1);
for (const r of abstractions.values()) r.onClear();
assert.equal(tracker.version(buffer), 2);
tracker.destroy();
assert.equal(abstractions.size, 0);
console.log(
  "Display-list attribute ranges, UVs, color composition and revision cleanup passed.",
);

// Native bitmap uploads coalesce their dirty flag. Independent Pixi uploads
// still need every edit, and must restore the inherited method on teardown.
const prototype = {
  invalidateGPU() {
    if (this.needUpload) return;
    this.needUpload = true;
  },
};
const bitmap = Object.assign(Object.create(prototype), {
  addAbstraction: buffer.addAbstraction,
  removeAbstraction: buffer.removeAbstraction,
});
const bitmapTracker = createAssetTracker();
assert.equal(bitmapTracker.version(bitmap, "invalidateGPU"), 0);
bitmap.invalidateGPU();
bitmap.invalidateGPU();
assert.equal(bitmapTracker.version(bitmap), 2);
assert.equal(bitmap.needUpload, true);
bitmapTracker.destroy();
assert.equal(Object.hasOwn(bitmap, "invalidateGPU"), false);
assert.equal(bitmap.invalidateGPU, prototype.invalidateGPU);
assert.equal(abstractions.size, 0);
