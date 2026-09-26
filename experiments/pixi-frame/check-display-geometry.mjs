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
const cache = createGeometryCache(tracker, stats, { retain: 0 });
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
// Geometry in use or retained keeps its buffers' tracker records alive across
// a sweep: an edit still invalidates through the same record, and a hidden
// animation frame that returns later does not rebuild.
tracker.epoch = 10;
tracker.sweep();
const buildsAfterSweep = stats.geometryBuilds;
cache.sync(b, shape, null, false);
assert.equal(stats.geometryBuilds, buildsAfterSweep, "an unchanged buffer survives the tracker sweep without a rebuild");
new Float32Array(positions.attributesBuffer.buffer)[2] = 30;
positions.invalidate();
cache.sync(b, shape, null, false);
assert.equal(b.geometry.positions[2], 30);
assert.equal(stats.geometryBuilds, buildsAfterSweep + 1, "an edit after the sweep still rebuilds once");
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

// Flash hairlines stay one render pixel wide, including enlarged previews.
const line = {
  elements: {
    assetType: "[asset LineElements]", dimension: 2, numVertices: 4, scaleMode: 4,
    positions: attribute(new Float32Array([0,0,20,0, 0,0,20,0, 20,0,0,0, 20,0,0,0]),4),
    thickness: attribute(new Float32Array([.5,-.5,-.5,.5]),1),
  },
};
const strokeTracker = createAssetTracker(), strokeStats = {geometryBuilds:0};
const strokes = createGeometryCache(strokeTracker, strokeStats, { retain: 0 });
function projectedWidth(entry, m) {
  const p=entry.geometry.positions;
  const x=m.a*(p[0]-p[2])+m.c*(p[1]-p[3]);
  const y=m.b*(p[0]-p[2])+m.d*(p[1]-p[3]);
  return Math.hypot(x,y);
}
const matrices = [
  {a:1,b:0,c:0,d:1}, {a:8,b:0,c:0,d:8},
  {a:0,b:6,c:-3,d:0}, {a:4,b:1,c:2,d:3}, {a:-5,b:0,c:0,d:2},
];
const entries=matrices.map(m=>strokes.sync(null,line,null,false,m));
entries.forEach((entry,i)=>assert.ok(Math.abs(projectedWidth(entry,matrices[i])-1)<1e-5));
assert.notEqual(entries[0].geometry,entries[1].geometry,'different scales need distinct extrusion');
const translated=strokes.sync(null,line,null,false,{...matrices[1],tx:100,ty:50});
assert.equal(translated.geometry,entries[1].geometry,'translation still shares geometry');
const buildsBefore=strokeStats.geometryBuilds;
strokes.sync(entries[1],line,null,false,matrices[1]);
assert.equal(strokeStats.geometryBuilds,buildsBefore,'unchanged hairlines are not rebuilt');
const normal={elements:{...line.elements,scaleMode:2}};
const scaled=strokes.sync(null,normal,null,false,matrices[1]);
assert.equal(projectedWidth(scaled,matrices[1]),8,'normal outlines still scale');
const none={elements:{...line.elements,scaleMode:1,thickness:attribute(new Float32Array([2,-2,-2,2]),1)}};
const fixed=strokes.sync(null,none,null,false,matrices[1]);
assert.equal(projectedWidth(fixed,matrices[1]),4,'non-scaling strokes preserve their width');
const collapsed=strokes.sync(null,line,null,false,{a:0,b:0,c:0,d:0});
assert.ok([...collapsed.geometry.positions].every(Number.isFinite));
for(const entry of [...entries,translated,scaled,fixed,collapsed])strokes.release(entry);
strokes.sweep();
assert.equal(strokeStats.geometryEntries,0);
strokes.destroy();strokeTracker.destroy();
console.log('Hairline/non-scaling widths and transform-aware geometry sharing passed.');
