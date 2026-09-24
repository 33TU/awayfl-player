import assert from "node:assert/strict";
import { createDirectScene } from "./direct-scene.mjs";

// CPU geometry must update even when no AwayFL vertex upload occurs. Exercise
// indexed subranges and edits to shared, interleaved position/UV buffers.
class Buffer {
  constructor(data, stride) {
    this.data = data;
    this.stride = stride;
  }
  get buffer() {
    return this.data.buffer;
  }
  invalidate() {}
}
const prototypeInvalidate = Buffer.prototype.invalidate;
const vertices = new Buffer(
  new Float32Array([0, 0, 0, 0, 10, 0, 1, 0, 10, 10, 1, 1, 0, 10, 0, 1]),
  16,
);
const indexBuffer = new Buffer(new Uint16Array([0, 1, 2, 0, 2, 3]), 6);
const view = (buffer, offset, dimensions, size = 4) => ({
  attributesBuffer: buffer,
  offset,
  dimensions,
  size,
  stride: buffer.stride / size,
  count: buffer.data.byteLength / buffer.stride,
});
const elements = {
  assetType: "[asset TriangleElements]",
  numVertices: 4,
  positions: view(vertices, 0, 2),
  uvs: view(vertices, 8, 2),
  indices: view(indexBuffer, 0, 3, 2),
};
const shader = {
  programData: { program: { _program: { program: {} } } },
  uvIndex: 1,
  curvesIndex: -1,
  normalIndex: -1,
  tangentIndex: -1,
  jointIndexIndex: -1,
  secondaryUVIndex: -1,
  colorBufferIndex: -1,
  cameraPositionIndex: -1,
  sceneMatrixIndex: -1,
  _setRenderState() {},
  vertexConstantData: new Float32Array(16),
  fragmentConstantData: new Float32Array(4),
  view: { viewMatrix3D: {} },
  viewMatrix: { copyFrom() {} },
};
const material = {
  material: { assetType: "[materials BasicMaterial]", blendMode: "normal" },
  numPasses: 1,
  requiresBlending: true,
  _passes: [
    {
      shader,
      _fragmentConstantsIndex: 0,
      _diffuseR: 1,
      _diffuseG: 1,
      _diffuseB: 1,
      _diffuseA: 1,
    },
  ],
};
const item = {
  renderMaterial: material,
  stageElements: { elements },
  _count: 1,
  _offset: 1,
  entity: {
    node: { container: {} },
    renderSceneTransform: { clone: () => ({ append() {} }) },
  },
};
const reasons = [];
const meta = {
  attributes: [{ name: "va0" }, { name: "va1" }],
  uniforms: [
    { name: "vc", type: 35666, size: 4 },
    { name: "fc", type: 35666, size: 1 },
  ],
  vertex: "",
  fragment: "",
};
const context = {
  metadata: () => meta,
  fallback: (r) => reasons.push(r),
  viewport: { x: 0, y: 0, width: 10, height: 10 },
};
const adapter = createDirectScene();
try {
  const first = adapter.recipe(item, context);
  assert.equal(first.count, 3);
  assert.deepEqual([...first.attributes.va0.data], [0, 0, 10, 10, 0, 10]);
  assert.deepEqual([...first.attributes.va1.data], [0, 0, 1, 1, 0, 1]);
  assert.equal(adapter.recipe(item, context).attributes, first.attributes);
  assert.equal(adapter.stats.geometryHits, 1);
  vertices.data[0] = 5;
  vertices.invalidate();
  const edited = adapter.recipe(item, context);
  assert.notEqual(edited.attributes, first.attributes);
  assert.deepEqual([...edited.attributes.va0.data], [5, 0, 10, 10, 0, 10]);
  indexBuffer.data[3] = 1;
  indexBuffer.invalidate();
  assert.deepEqual(
    [...adapter.recipe(item, context).attributes.va0.data],
    [10, 0, 10, 10, 0, 10],
  );
  item._offset = 0;
  assert.deepEqual(
    [...adapter.recipe(item, context).attributes.va0.data],
    [5, 0, 10, 0, 10, 10],
  );
  item._offset = 1;
  // Layout mutations and replacing backing storage must not return stale data,
  // even when the caller does not issue a content invalidation.
  elements.uvs.offset = 0;
  assert.deepEqual(
    [...adapter.recipe(item, context).attributes.va1.data],
    [10, 0, 10, 10, 0, 10],
  );
  elements.uvs.offset = 8;
  vertices.data = new Float32Array(vertices.data);
  vertices.data[4] = 17;
  assert.deepEqual(
    [...adapter.recipe(item, context).attributes.va0.data],
    [17, 0, 10, 10, 0, 10],
  );
  elements.positions = { ...elements.positions, dimensions: 3 };
  assert.deepEqual(
    [...adapter.recipe(item, context).attributes.va0.data],
    [17, 0, 1, 10, 10, 1, 0, 10, 0],
  );
  const hits = adapter.stats.geometryHits;
  adapter.recipe(item, context);
  assert.equal(adapter.stats.geometryHits, hits + 1);
  elements.positions.dimensions = 2;
  vertices.stride = 8;
  assert.deepEqual(
    [...adapter.recipe(item, context).attributes.va0.data],
    [0, 0, 17, 0, 1, 0],
  );
  vertices.stride = 16;
  assert.deepEqual(
    [...adapter.recipe(item, context).attributes.va0.data],
    [17, 0, 10, 10, 0, 10],
  );
  // Cached layer quads sample their own texture and must not overwrite an
  // unrelated diffuse constant or double-blend a precomposited backdrop.
  material.material.assetType = "[renderer CacheRenderer]";
  material.material.useNonNativeBlend = true;
  material._passes[0]._texture = {};
  shader.fragmentConstantData.set([0.2, 0.4, 0.6, 0.8]);
  const before = [...shader.fragmentConstantData];
  Object.assign(shader, {
    writeDepth: true,
    usesBlending: false,
    depthCompareMode: 5,
    _blendFactor: [2, 9],
    _blendEquation: [0, 0],
  });
  const cached = adapter.recipe(item, { ...context, nativeProjection: true });
  assert.equal(cached.blend, "none");
  assert.equal(cached.raster.depthWrite, false);
  assert.equal(cached.raster.cull, null);
  assert.deepEqual(cached.raster.blendFactors, [2, 9]);
  assert.deepEqual([...shader.fragmentConstantData], before);
  // Each draw must retain its own constants when a shared shader is reused.
  const vertexSnapshot = [...cached.uniforms.vc.value];
  const fragmentSnapshot = [...cached.uniforms.fc.value];
  shader.vertexConstantData.fill(0.75);
  shader.fragmentConstantData.fill(0.5);
  const nextDraw = adapter.recipe(item, context);
  assert.deepEqual([...cached.uniforms.vc.value], vertexSnapshot);
  assert.deepEqual([...cached.uniforms.fc.value], fragmentSnapshot);
  assert.deepEqual([...nextDraw.uniforms.vc.value], Array(16).fill(0.75));
  assert.deepEqual([...nextDraw.uniforms.fc.value], Array(4).fill(0.5));
  item.entity.node.container.animator = {};
  assert.equal(adapter.recipe(item, context), null);
  assert.deepEqual(reasons, ["animator"]);
} finally {
  adapter.destroy();
}
assert.equal(Buffer.prototype.invalidate, prototypeInvalidate);
console.log(
  "Direct geometry: indexed ranges, UVs, reuse, vertex/index edits, cached quads, fallback and cleanup passed.",
);
