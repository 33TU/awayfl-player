import {
  DefaultBatcher, ExtensionType, extensions, Shader,
  compileHighShaderGlProgram, colorBitGl, generateTextureBatchBitGl,
  roundPixelsBitGl, getBatchSamplersUniformGroup,
} from "pixi.js";
import { planUploadRanges, installRangeUploads } from "./upload-ranges.mjs";
import { vectorInputs, sameVectorInputs } from "./vector-inputs.mjs";

const shaders = new Map();
function shaderFor(maxTextures) {
  let shader = shaders.get(maxTextures);
  if (!shader) {
    const textureBit = generateTextureBatchBitGl(maxTextures);
    shader = new Shader({
      glProgram: compileHighShaderGlProgram({
        name: "flash-vector-batch",
        bits: [colorBitGl, { ...textureBit, fragment: { ...textureBit.fragment,
          main: textureBit.fragment.main.replaceAll("vUV", "flashUV") } }, roundPixelsBitGl, {
          name: "flash-vectors",
          vertex: {
            header: "in vec4 aVector; in vec4 aRect; in vec4 aMultiply; in vec4 aOffset; out vec4 vVector; out vec4 vRect; out vec4 vMultiply; out vec4 vOffset;",
            main: "vVector = aVector; vRect = aRect; vMultiply = aMultiply; vOffset = aOffset;",
          },
          fragment: {
            header: "in vec4 vVector; in vec4 vRect; in vec4 vMultiply; in vec4 vOffset;",
            start: `if ((vVector.y * vVector.y - vVector.z) * vVector.x < 0.0) discard;
              vec2 flashUV = (vVector.w > 0.5 ? vec2(clamp(length(vUV), 0.0, 1.0), 0.0) : vUV) * vRect.xy + vRect.zw;`,
            main: `vec3 rgb = outColor.a > 0.0 ? outColor.rgb / outColor.a : vec3(0.0);
              outColor = clamp(vec4(rgb, outColor.a) * vMultiply + vOffset, 0.0, 1.0);
              outColor.rgb *= outColor.a;`,
          },
        }],
      }),
      resources: { batchSamplers: getBatchSamplersUniformGroup(maxTextures) },
    });
    shader.maxTextures = maxTextures;
    shaders.set(maxTextures, shader);
  }
  return shader;
}

// Preserve Flash color transforms, atlas rectangles, radial fills and analytic
// curves as per-vertex inputs so adjacent meshes can share a Pixi batch.
class VectorBatcher extends DefaultBatcher {
  static extension = { type: ExtensionType.Batcher, name: "flash-vectors" };
  constructor(options) {
    super(options);
    this.name = "flash-vectors";
    this.vertexSize = 22;
    this.inputScratch = [];
    this.unchangedUpdates = this.packedUpdates = 0;
    for (const attribute of Object.values(this.geometry.attributes)) attribute.stride = 88;
    for (const [name, offset] of [["aVector", 24], ["aRect", 40], ["aMultiply", 56], ["aOffset", 72]])
      this.geometry.addAttribute(name, {
        buffer: this.geometry.getBuffer("aPosition"), format: "float32x4", stride: 88, offset,
      });
    this.shader = shaderFor(options.maxTextures);
  }
  _updateMaxTextures(maxTextures) { this.shader = shaderFor(maxTextures); }
  begin() {
    super.begin();
    this.fullUpload = true;
    this.changedStart = Infinity;
    this.changedEnd = 0;
    this.changedRanges = [];
    this.packedInputs = new WeakMap();
  }
  updateElement(element) {
    if (element.flashSkipUnchanged) {
      const inputs = vectorInputs(element, this.attributeBuffer.float32View,
        element._attributeStart, element._textureId, this.inputScratch);
      if (sameVectorInputs(this.packedInputs.get(element), inputs)) {
        this.unchangedUpdates++;
        return;
      }
    }
    this.packedUpdates++;
    super.updateElement(element);
    this.changedStart = Math.min(this.changedStart, element._attributeStart);
    this.changedEnd = Math.max(this.changedEnd, element._attributeStart + element.attributeSize * this.vertexSize);
    if (!this.fullUpload) this.changedRanges.push([element._attributeStart, element._attributeStart + element.attributeSize * this.vertexSize]);
  }
  packAttributes(element, floats, uints, index, textureId) {
    if (element.flashSkipUnchanged)
      this.packedInputs.set(element, vectorInputs(element, floats, index, textureId, this.inputScratch).slice());
    const wt = element.transform, { positions, uvs } = element;
    const curves = element.geometry.attributes.aCurve?.buffer.data;
    const color = element.color;
    const rect = element.renderable.flashRect;
    const sx = rect?.width ?? 1, sy = rect?.height ?? 1, ox = rect?.x ?? 0, oy = rect?.y ?? 0;
    const multiply = element.renderable.flashMultiply, offset = element.renderable.flashOffset;
    const radial = element.renderable.flashRadial || 0;
    const textureAndRound = textureId << 16 | element.roundPixels & 65535;
    for (let i = element.attributeOffset, end = i + element.attributeSize; i < end; i++) {
      const x = positions[i * 2], y = positions[i * 2 + 1];
      floats[index++] = wt.a * x + wt.c * y + wt.tx;
      floats[index++] = wt.b * x + wt.d * y + wt.ty;
      floats[index++] = uvs[i * 2];
      floats[index++] = uvs[i * 2 + 1];
      uints[index++] = color;
      uints[index++] = textureAndRound;
      floats[index++] = curves?.[i * 3] || 0;
      floats[index++] = curves?.[i * 3 + 1] || 0;
      floats[index++] = curves?.[i * 3 + 2] || 0;
      floats[index++] = radial;
      floats[index++] = sx; floats[index++] = sy; floats[index++] = ox; floats[index++] = oy;
      for (let j = 0; j < 4; j++) floats[index++] = multiply?.[j] ?? 1;
      for (let j = 0; j < 4; j++) floats[index++] = offset?.[j] ?? 0;
    }
  }
}
extensions.add(VectorBatcher);

export function installVectorBatcher(renderer, partialUploads = true, sparseUploads = true, skipUnchanged = true, defaultRanges = false) {
  // Renderer-local adapter: ordinary sprites, filters and mask pipes are intact.
  const pipe = renderer.renderPipes.mesh;
  const initialize = pipe._initBatchableMesh;
  const initializeVector = function(mesh) {
    const element = initialize.call(this, mesh);
    if (mesh.flashVectorBatch) element.batcherName = "flash-vectors";
    element.flashSkipUnchanged = skipUnchanged;
    return element;
  };
  pipe._initBatchableMesh = initializeVector;
  const batches = renderer.renderPipes.batch, upload = batches.upload;
  const ranges = partialUploads && sparseUploads ? installRangeUploads(renderer) : null;
  let uploadVector;
  const buildStart = batches.buildStart;
  const defaultHooks = new WeakMap();
  const startRanges = function(instructions) {
    buildStart.call(this, instructions);
    const batch = this._batchersByInstructionSet[instructions.uid].default;
    if (!defaultHooks.has(batch)) {
      const update = batch.updateElement;
      const wrapper = function(element) {
        let inputs;
        // Meshes expose revisioned attributes; reuse the existing exact-input
        // check. Graphics and sprites keep Pixi's normal packing behavior.
        if (element.flashSkipUnchanged) {
          inputs = vectorInputs(element, this.attributeBuffer.float32View,
            element._attributeStart, element._textureId, this.inputScratch);
          if (sameVectorInputs(this.packedInputs.get(element), inputs)) {
            this.unchangedUpdates++;
            return;
          }
        }
        update.call(this, element);
        this.packedUpdates++;
        if (inputs) this.packedInputs.set(element, inputs.slice());
        const start = element._attributeStart;
        const end = start + element.attributeSize * this.vertexSize;
        this.changedStart = Math.min(this.changedStart, start);
        this.changedEnd = Math.max(this.changedEnd, end);
        if (!this.fullUpload) this.changedRanges.push([start, end]);
      };
      batch.updateElement = wrapper;
      defaultHooks.set(batch, { update, wrapper });
    }
    // A rebuilt instruction set can move every element to a new buffer slot.
    batch.unchangedUpdates ??= 0;
    batch.packedUpdates ??= 0;
    batch.inputScratch = [];
    batch.packedInputs = new WeakMap();
    batch.fullUpload = true;
    batch.changedStart = Infinity;
    batch.changedEnd = 0;
    batch.changedRanges = [];
  };
  if (partialUploads && defaultRanges) batches.buildStart = startRanges;
  if (partialUploads) {
    uploadVector = function(instructions) {
      const set = this._batchersByInstructionSet[instructions.uid];
      const tracked = [set?.["flash-vectors"], defaultRanges && set?.default].filter(Boolean);
      for (const vector of tracked) {
        const buffer = vector?.geometry.buffers[0];
        const gpu = buffer?._gpuData[renderer.uid];
        // Any new upload supersedes a deferred ticket. If the earlier revision
        // was never consumed, the guard below forces a complete buffer update.
        if (vector?.dirty) ranges?.clear(buffer);
        // A hidden/cached group may have queued an update without consuming it.
        // Fall back to a full upload unless the GPU has the previous revision,
        // so a later edit cannot overwrite an earlier pending update range.
        if (vector?.dirty && !vector.fullUpload && gpu?.updateID === buffer._updateID && vector.changedEnd > vector.changedStart) {
          // Union all edited vertex ranges since the last upload. A structural
          // rebuild still uploads the entire buffer, including changed offsets.
          buffer.update((vector.changedEnd-vector.changedStart)*4, vector.changedStart*4);
          if (ranges) ranges.queue(buffer, planUploadRanges(vector.changedRanges));
          vector.dirty = false;
        }
      }
      upload.call(this, instructions);
      for (const vector of tracked) {
        vector.fullUpload = false;
        vector.changedStart = Infinity;
        vector.changedEnd = 0;
        vector.changedRanges = [];
      }
    };
    batches.upload = uploadVector;
  }
  return () => {
    if (pipe._initBatchableMesh === initializeVector) pipe._initBatchableMesh = initialize;
    if (batches.upload === uploadVector) batches.upload = upload;
    if (batches.buildStart === startRanges) batches.buildStart = buildStart;
    for (const set of Object.values(batches._batchersByInstructionSet)) {
      const batch = set.default, hook = defaultHooks.get(batch);
      if (hook && batch.updateElement === hook.wrapper) batch.updateElement = hook.update;
    }
    ranges?.restore();
  };
}
