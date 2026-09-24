import assert from "node:assert/strict";
import { createMeshBatcher } from "./mesh-batches.mjs";
const limits = {
  vertexVectors: 256,
  fragmentVectors: 224,
  attributes: 16,
  limit: 4,
};
const texture = {
  handle: {},
  scaleMode: "linear",
  addressMode: "clamp-to-edge",
};
const vertex = `#version 300 es
precision highp float;
uniform vec4 vc[4];in vec4 va0;
vec4 transform(int n,vec4 v){return vec4(dot(v,vc[n+0]),dot(v,vc[n+1]),dot(v,vc[n+2]),dot(v,vc[n+3]));}
void main(){gl_Position=transform(0,va0);}`;
const fragment = `#version 300 es
precision highp float;
uniform vec4 fc[1];out vec4 color;void main(){color=fc[0];}`;
function entry(n) {
  return {
    key: { n },
    recipe: {
      vertex,
      fragment,
      count: 3,
      blend: "normal",
      offscreen: false,
      viewport: { x: 0, y: 0, width: 100, height: 100 },
      bounds: { x: n * 10, y: 0, width: 10, height: 10 },
      attributes: {
        va0: {
          size: 4,
          data: new Float32Array([n, 0, 0, 1, n, 1, 0, 1, n + 1, 0, 0, 1]),
        },
      },
      uniforms: {
        vc: { type: 35666, size: 4, value: new Float32Array(16).fill(n) },
        fc: { type: 35666, size: 1, value: new Float32Array([1, 0, 0, 1]) },
      },
      samplers: { fs0: texture },
    },
  };
}
const batcher = createMeshBatcher(limits),
  entries = Array.from({ length: 6 }, (_, i) => entry(i));
batcher.begin();
const result = batcher.batch(entries);
assert.equal(result.length, 2);
assert.equal(result[0].recipe.count, 12);
assert.equal(result[1].recipe.count, 6);
assert.deepEqual(
  [...result[0].recipe.attributes.aAwayBatchId.data],
  [0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3],
);
assert.deepEqual(
  [...result[0].recipe.uniforms.uAwayBatch_vc.value],
  entries.slice(0, 4).flatMap((e) => [...e.recipe.uniforms.vc.value]),
);
assert.equal(result[0].recipe.fragment, fragment);
assert.equal(result[0].recipe.uniforms.fc.value[0], 1);
assert.match(
  result[0].recipe.vertex,
  /uAwayBatch_vc\[int\(aAwayBatchId \+ 0.5\) \* 4 \+ \(n\+0\)\]/,
);
assert.ok(result[0].recipe.vertex.startsWith("#version 300 es\n"));
assert.deepEqual(result[0].recipe.bounds, {
  x: 0,
  y: 0,
  width: 40,
  height: 10,
});
// Moving/color-changing meshes reuse geometry but capture fresh constants.
batcher.begin();
entries[1].recipe.uniforms.vc.value[0] = 0.75;
const moved = batcher.batch(entries);
assert.equal(moved[0].recipe.attributes, result[0].recipe.attributes);
assert.equal(moved[0].recipe.uniforms.uAwayBatch_vc.value[16], 0.75);
assert.equal(result[0].recipe.uniforms.uAwayBatch_vc.value[16], 1);
entries[1].recipe.attributes = {
  va0: { size: 4, data: new Float32Array(12).fill(9) },
};
assert.notEqual(
  batcher.batch(entries)[0].recipe.attributes,
  moved[0].recipe.attributes,
);
// A state boundary remains between its original neighbours; never sort by texture.
for (const change of [
  (g) => (g.uniforms.fc.value[0] = 0.5),
  (g) => (g.blend = "add"),
  (g) => (g.samplers = { fs0: { ...texture, handle: {} } }),
  (g) => (g.samplers = { fs0: { ...texture, scaleMode: "nearest" } }),
  (g) => (g.viewport = { ...g.viewport, x: 1 }),
  (g) => (g.raster = { depthWrite: true }),
]) {
  const es = [entry(0), entry(1), entry(2)];
  change(es[1].recipe);
  assert.equal(batcher.batch(es).length, 3);
}
// Unknown constants and insufficient GL uniform budgets keep the unbatched path.
const unsupported = entry(0);
unsupported.recipe.uniforms = {
  custom: { type: 35666, size: 1, value: [1, 0, 0, 1] },
};
assert.equal(batcher.batch([unsupported, entry(1)]).length, 2);
assert.equal(batcher.batch([unsupported, unsupported]).length, 2);
const small = createMeshBatcher({ ...limits, vertexVectors: 20 });
assert.equal(small.batch([entry(0), entry(1)]).length, 2);
small.destroy();
const short = createMeshBatcher({ ...limits, maxVertices: 3 });
assert.equal(short.batch([entry(0), entry(1)]).length, 2);
short.destroy();
batcher.destroy();
console.log(
  "Batch limits, shader rewriting, order/state boundaries, geometry reuse and constant isolation passed.",
);
