import assert from "node:assert/strict";
import {
  triangleData,
  readAttribute,
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
// Packed attributes must be copied: the caller transforms their values while
// other shapes may still use the source buffer. Interleaved 32-bit indices
// exercise the same decoder with a different component type.
const packedBuffer = new Float32Array([1, 2, 3, 4]).buffer;
const packed = { attributesBuffer: { buffer: packedBuffer, stride: 8 }, offset: 0,
  size: 4, dimensions: 2, count: 2 };
const decoded = readAttribute(packed);
decoded[0] = 99;
assert.deepEqual([...new Float32Array(packedBuffer)], [1, 2, 3, 4]);
const wideIndices = new Uint32Array([7, 99, 8, 99]).buffer;
assert.deepEqual([...readAttribute({ attributesBuffer: { buffer: wideIndices, stride: 8 },
  offset: 0, size: 4, dimensions: 1, count: 2 }, 1, true)], [7, 8]);
const unaligned = new ArrayBuffer(9);
new DataView(unaligned).setFloat32(1, 1.5, true);
new DataView(unaligned).setFloat32(5, 2.5, true);
assert.deepEqual([...readAttribute({ attributesBuffer: { buffer: unaligned, stride: 4 },
  offset: 1, size: 4, dimensions: 1, count: 2 })], [1.5, 2.5]);
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

// Skipped branches must keep asset notifications alive without per-frame reads.
const changes = [], ownerA = {}, ownerB = {};
const retainedTracker = createAssetTracker(owner => changes.push(owner));
const retainedImage = Object.assign(Object.create(prototype), {
  addAbstraction: buffer.addAbstraction, removeAbstraction: buffer.removeAbstraction,
});
for (const owner of [ownerA, ownerB]) {
  retainedTracker.beginOwner(owner);
  retainedTracker.version(retainedImage, 'invalidateGPU', '_imageDataDirty');
  retainedTracker.endOwner();
}
retainedTracker.epoch=100;
retainedTracker.sweep();
assert.equal(retainedTracker.retained(retainedImage), true);
retainedImage.invalidateGPU();retainedImage.invalidateGPU();
assert.deepEqual(changes,[ownerA,ownerB,ownerA,ownerB]);
changes.length=0;
retainedImage._imageDataDirty=true;
assert.deepEqual(changes,[ownerA,ownerB],'GPU-side edits wake every retained consumer');
retainedTracker.releaseOwner(ownerA);changes.length=0;
retainedImage._imageDataDirty=false;
assert.deepEqual(changes,[ownerB]);
retainedTracker.beginOwner(ownerB);retainedTracker.endOwner();
assert.equal(retainedTracker.retained(retainedImage),false,'replaced geometry releases old dependencies');
retainedTracker.sweep();
assert.equal(Object.getOwnPropertyDescriptor(retainedImage,'_imageDataDirty').value,false);
assert.equal(Object.hasOwn(retainedImage,'invalidateGPU'),false);
assert.equal(abstractions.size,0);
retainedTracker.destroy();
console.log('Retained asset notifications, shared owners, GPU edits and retirement passed.');
