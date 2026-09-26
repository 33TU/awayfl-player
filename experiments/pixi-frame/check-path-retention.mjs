import assert from 'node:assert/strict';
import { createNativePaths } from './native-paths.mjs';
import { createGeometryCache } from './display-list-geometry.mjs';

// Authored solid-fill triangle as the path source snapshots it.
const solidPath = (offset = 0) => Object.freeze({ contours: 1, color: 0x2266cc, alpha: 1,
  segments: Object.freeze([
    { command: 1, args: [offset, 0] }, { command: 2, args: [offset + 30, 0] },
    { command: 2, args: [offset + 30, 30] },
  ]) });

{
  const stats = {};
  const paths = createNativePaths(stats, null, { retain: 2 });
  const a = solidPath(0), b = solidPath(10), c = solidPath(20), d = solidPath(30);
  const first = paths.acquire(a);
  const context = first.entry.context;
  paths.release(first.entry);
  paths.sweep();
  assert.equal(stats.nativePathRetained, 1, 'an unused vector context is retained');
  assert.equal(context.destroyed, false);
  const again = paths.acquire(a);
  assert.equal(again.entry.context, context, 'reacquiring reuses the retained context');
  assert.equal(stats.nativePathRevivals, 1);
  assert.equal(stats.nativePathBuilds, 1, 'no rebuild for a retained path');
  paths.release(again.entry);
  for (const path of [b, c, d]) paths.release(paths.acquire(path).entry);
  paths.sweep();
  assert.equal(stats.nativePathRetained, 2, 'retention is bounded');
  assert.equal(context.destroyed, true, 'the oldest unused context is destroyed first');
  assert.equal(paths.acquire(d).entry.context.destroyed, false, 'the newest survive');
  assert.equal(stats.nativePathBuilds, 4);

  // Texture-backed entries are never retained past their last user.
  const bitmap = Object.freeze({ ...solidPath(40), bitmap: Object.freeze({ image: {}, width: 4, height: 4,
    uv: Object.freeze([1, 0, 0, 1, 0, 0]) }) });
  const textured = paths.acquire(bitmap, { fake: true });
  paths.release(textured.entry);
  paths.sweep();
  assert.equal(textured.entry.context.destroyed, true, 'bitmap contexts follow the texture lifetime');
  paths.destroy();
  assert.equal(stats.nativePathRetained, 0);

  const immediate = createNativePaths({}, null, { retain: 0 });
  const entry = immediate.acquire(a).entry;
  immediate.release(entry);
  immediate.sweep();
  assert.equal(entry.context.destroyed, true, 'retainPaths=0 restores immediate release');
}

{
  const versions = new Map();
  const tracker = { version: b => versions.get(b) || 1 };
  const stats = { geometryBuilds: 0 };
  const cache = createGeometryCache(tracker, stats, { retain: 1 });
  const elements = (index) => {
    const buffer = { buffer: new ArrayBuffer(48), stride: 8 };
    return { assetType: '[asset TriangleElements]', numVertices: 3, dimension: 2,
      positions: { attributesBuffer: buffer, offset: 0, dimensions: 2, size: 4, count: 3 },
      indices: null, uvs: null, thickness: null, id: index };
  };
  const shapeA = { elements: elements(1) }, shapeB = { elements: elements(2) };
  const a = cache.sync(null, shapeA, null, false, null);
  assert.equal(stats.geometryBuilds, 1);
  cache.release(a);
  cache.sweep();
  assert.equal(stats.geometryRetained, 1);
  const reused = cache.sync(null, shapeA, null, false, null);
  assert.equal(reused, a, 'the retained geometry entry is reused');
  assert.equal(stats.geometryBuilds, 1, 'no rebuild when the signature is unchanged');
  cache.release(reused);
  const b = cache.sync(null, shapeB, null, false, null);
  cache.release(b);
  cache.sweep();
  assert.equal(stats.geometryRetained, 1, 'geometry retention is bounded');
  assert.equal(stats.geometryEntries, 1, 'the oldest unused geometry is destroyed');
  assert.equal(cache.sync(null, shapeB, null, false, null), b, 'the newest unused geometry survives');
  cache.sync(null, shapeA, null, false, null);
  assert.equal(stats.geometryBuilds, 3, 'an evicted geometry is rebuilt on demand');
  cache.destroy();
}

console.log('Path retention: native contexts and mesh geometry are reused across sweeps within their limits');
