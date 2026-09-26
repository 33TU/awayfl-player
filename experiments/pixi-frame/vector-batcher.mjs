import {
  DefaultBatcher, ExtensionType, extensions, Shader, BufferImageSource, GlProgram,
  compileHighShaderGlProgram, compileHighShaderGl, vertexGlTemplate, fragmentGlTemplate,
  globalUniformsBitGl, colorBitGl, generateTextureBatchBitGl,
  roundPixelsBitGl, getBatchSamplersUniformGroup,
} from "pixi.js";
import { planUploadRanges, installRangeUploads } from "./upload-ranges.mjs";
import { vectorInputs, sameVectorInputs } from "./vector-inputs.mjs";

// Instanced transforms keep every mesh's vertices in its own local space and
// look the world transform up from a per-batcher float texture in the vertex
// shader. Pixi's batchers bake the transform into the vertex stream, so every
// animated mesh was repacked and re-uploaded on every frame (13 percent of a
// busy frame in bufferSubData alone, t7.json). With the table a moved mesh
// rewrites 32 bytes. WebGL2 only (texelFetch in the vertex shader).
const MATRIX_WIDTH = 256;             // texels per row: 128 matrices
const MATRIX_STRIDE = 8;              // floats per matrix: two RGBA texels
let instancedTransforms = false;

const shaders = new Map();
function shaderFor(maxTextures, instanced) {
  const key = maxTextures + (instanced ? ":i" : "");
  let shader = shaders.get(key);
  if (!shader) {
    const textureBit = generateTextureBatchBitGl(maxTextures);
    const transformBit = instanced ? {
      name: "flash-instanced-transforms",
      vertex: {
        header: "in float aMatrix; uniform sampler2D uMatrices;",
        main: `int mi = int(aMatrix + 0.5) * 2;
          vec4 m0 = texelFetch(uMatrices, ivec2(mi % ${MATRIX_WIDTH}, mi / ${MATRIX_WIDTH}), 0);
          vec4 m1 = texelFetch(uMatrices, ivec2((mi + 1) % ${MATRIX_WIDTH}, (mi + 1) / ${MATRIX_WIDTH}), 0);
          position = vec2(m0.x * aPosition.x + m0.z * aPosition.y + m1.x, m0.y * aPosition.x + m0.w * aPosition.y + m1.y);`,
      },
    } : null;
    const bits = [colorBitGl, { ...textureBit, fragment: { ...textureBit.fragment,
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
        }, ...(transformBit ? [transformBit] : [])];
    const name = "flash-vector-batch" + (instanced ? "-instanced" : "");
    let glProgram;
    if (instanced) {
      // Pixi compiles its batch programs as GLSL ES 1.00 even on WebGL2, and
      // texelFetch needs ES 3.00: compile the same templates with the version
      // directive, which also skips Pixi's ES 1.00 compatibility defines.
      const source = compileHighShaderGl({
        template: { vertex: vertexGlTemplate, fragment: fragmentGlTemplate },
        bits: [globalUniformsBitGl, ...bits],
      });
      glProgram = new GlProgram({ name, vertex: "#version 300 es\n" + source.vertex,
        fragment: "#version 300 es\n" + source.fragment });
    } else {
      glProgram = compileHighShaderGlProgram({ name, bits });
    }
    shader = new Shader({
      glProgram,
      resources: { batchSamplers: getBatchSamplersUniformGroup(maxTextures) },
    });
    shader.maxTextures = maxTextures;
    shaders.set(key, shader);
  }
  return shader;
}

// Preserve Flash color transforms, atlas rectangles, radial fills and analytic
// curves as per-vertex inputs so adjacent meshes can share a Pixi batch.
class VectorBatcher extends DefaultBatcher {
  static extension = { type: ExtensionType.Batcher, name: "flash-vectors" };
  static traceInputs = false;
  static inputDiffs = {};
  constructor(options) {
    super(options);
    this.name = "flash-vectors";
    this.instanced = instancedTransforms;
    // The matrix texture takes the last sampler unit, so batching gets one less.
    this.maxTextures = this.instanced ? Math.max(1, options.maxTextures - 1) : options.maxTextures;
    this.vertexSize = this.instanced ? 23 : 22;
    const stride = this.vertexSize * 4;
    this.inputScratch = [];
    this.unchangedUpdates = this.packedUpdates = this.matrixUpdates = 0;
    for (const attribute of Object.values(this.geometry.attributes)) attribute.stride = stride;
    const layout = [["aVector", 24], ["aRect", 40], ["aMultiply", 56], ["aOffset", 72]];
    if (this.instanced) layout.push(["aMatrix", 88]);
    for (const [name, offset] of layout)
      this.geometry.addAttribute(name, {
        buffer: this.geometry.getBuffer("aPosition"),
        format: name === "aMatrix" ? "float32" : "float32x4", stride, offset,
      });
    this.shader = shaderFor(this.maxTextures, this.instanced);
    this.matrixCount = 0;
    this.matrices = new Float32Array(MATRIX_WIDTH * 4 * 4);
    this.matrixTexture = null;
    this.matrixDirty = false;
  }
  _updateMaxTextures(maxTextures) {
    this.maxTextures = this.instanced ? Math.max(1, maxTextures - 1) : maxTextures;
    this.shader = shaderFor(this.maxTextures, this.instanced);
  }
  begin() {
    super.begin();
    this.fullUpload = true;
    this.changedStart = Infinity;
    this.changedEnd = 0;
    this.changedRanges = [];
    this.packedInputs = new WeakMap();
    // Elements are re-added on a rebuild; slots are reassigned from zero.
    this.matrixCount = 0;
  }
  add(element) {
    super.add(element);
    if (this.instanced) {
      element.flashMatrix = this.matrixCount++;
      const needed = this.matrixCount * MATRIX_STRIDE;
      if (needed > this.matrices.length) {
        const grown = new Float32Array(Math.max(needed, this.matrices.length * 2));
        grown.set(this.matrices);
        this.matrices = grown;
        this.matrixTexture?.destroy();
        this.matrixTexture = null;
      }
    }
  }
  writeMatrix(element) {
    const wt = element.transform, at = element.flashMatrix * MATRIX_STRIDE, m = this.matrices;
    if (m[at] === wt.a && m[at + 1] === wt.b && m[at + 2] === wt.c && m[at + 3] === wt.d &&
        m[at + 4] === wt.tx && m[at + 5] === wt.ty) return false;
    m[at] = wt.a; m[at + 1] = wt.b; m[at + 2] = wt.c; m[at + 3] = wt.d;
    m[at + 4] = wt.tx; m[at + 5] = wt.ty;
    this.matrixDirty = true;
    return true;
  }
  // Called by the GL adaptor hook before a batch draws: bind the table.
  syncMatrixTexture(renderer, unit) {
    const rows = Math.max(1, Math.ceil(this.matrices.length / (MATRIX_WIDTH * 4)));
    if (!this.matrixTexture) {
      this.matrixTexture = new BufferImageSource({
        resource: this.matrices, width: MATRIX_WIDTH, height: rows, format: "rgba32float",
        scaleMode: "nearest", autoGenerateMipmaps: false, alphaMode: "no-premultiply-alpha",
        label: "flash-matrices",
      });
      this.matrixDirty = false;
    } else if (this.matrixDirty) {
      this.matrixTexture.update();
      this.matrixDirty = false;
    }
    renderer.texture.bind(this.matrixTexture, unit);
  }
  updateElement(element) {
    if (element.flashSkipUnchanged) {
      const inputs = vectorInputs(element, this.attributeBuffer.float32View,
        element._attributeStart, element._textureId, this.inputScratch, !this.instanced);
      const previous = this.packedInputs.get(element);
      if (sameVectorInputs(previous, inputs)) {
        // Only the transform can have changed: rewrite its matrix row.
        if (this.instanced && this.writeMatrix(element)) this.matrixUpdates++;
        this.unchangedUpdates++;
        return;
      }
      if (VectorBatcher.traceInputs) {
        const d = VectorBatcher.inputDiffs;
        let at = -1;
        if (!previous) at = "none";
        else if (previous.length !== inputs.length) at = "length";
        else for (let i = 0; i < inputs.length; i++) if (previous[i] !== inputs[i]) { at = i; break; }
        const kind = element.geometry ? "mesh" : "graphics";
        d[kind + ":" + at] = (d[kind + ":" + at] || 0) + 1;
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
      this.packedInputs.set(element, vectorInputs(element, floats, index, textureId, this.inputScratch, !this.instanced).slice());
    const instanced = this.instanced;
    const wt = element.transform, { positions, uvs } = element;
    // Batchable graphics carry geometryData instead of a mesh geometry.
    const curves = element.geometry?.attributes?.aCurve?.buffer.data;
    const color = element.color;
    const rect = element.renderable.flashRect;
    const sx = rect?.width ?? 1, sy = rect?.height ?? 1, ox = rect?.x ?? 0, oy = rect?.y ?? 0;
    const multiply = element.renderable.flashMultiply, offset = element.renderable.flashOffset;
    const radial = element.renderable.flashRadial || 0;
    const textureAndRound = textureId << 16 | element.roundPixels & 65535;
    const slot = instanced ? element.flashMatrix : 0;
    if (instanced) this.writeMatrix(element);
    const a = wt.a, b = wt.b, c = wt.c, d = wt.d, tx = wt.tx, ty = wt.ty;
    for (let i = element.attributeOffset, end = i + element.attributeSize; i < end; i++) {
      const x = positions[i * 2], y = positions[i * 2 + 1];
      if (instanced) { floats[index++] = x; floats[index++] = y; }
      else { floats[index++] = a * x + c * y + tx; floats[index++] = b * x + d * y + ty; }
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
      if (instanced) floats[index++] = slot;
    }
  }
  destroy() {
    this.matrixTexture?.destroy();
    this.matrixTexture = null;
    super.destroy();
  }
}
extensions.add(VectorBatcher);

export function installVectorBatcher(renderer, partialUploads = true, sparseUploads = true, skipUnchanged = true, defaultRanges = false, instanced = false) {
  // Renderer-local adapter: ordinary sprites, filters and mask pipes are intact.
  instancedTransforms = !!instanced && renderer.context?.webGLVersion === 2;
  const pipe = renderer.renderPipes.mesh;
  // With instanced transforms, native Graphics batches join the Flash batcher
  // too: two batchers alternating at every z-order boundary made nearly every
  // object its own draw call (4400 draws and 2700 program switches a frame),
  // and moved Graphics otherwise repack their vertices like meshes did.
  const graphicsPipe = renderer.renderPipes.graphics;
  const addGraphics = graphicsPipe?._addToBatcher;
  let addGraphicsVector;
  if (instancedTransforms && addGraphics) {
    addGraphicsVector = function(graphics, instructionSet) {
      const batches = this._getGpuDataForRenderable(graphics).batches;
      for (let i = 0; i < batches.length; i++) {
        batches[i].batcherName = "flash-vectors";
        batches[i].flashSkipUnchanged = skipUnchanged;
      }
      return addGraphics.call(this, graphics, instructionSet);
    };
    graphicsPipe._addToBatcher = addGraphicsVector;
  }
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
  // The batch shader's uniforms are synced only on its first bind, so the
  // per-batcher matrix texture is bound by hand on its own sampler unit
  // right before each batch draws, once the program is active.
  const adaptor = batches._adaptor;
  const adaptorExecute = adaptor?.execute;
  let executeInstanced;
  if (instancedTransforms && adaptorExecute) {
    const samplerSet = new WeakSet();
    executeInstanced = function(batchPipe, batch) {
      const batcher = batch.batcher;
      if (batcher instanceof VectorBatcher && batcher.instanced) {
        const unit = batcher.maxTextures;
        batcher.syncMatrixTexture(renderer, unit);
        const program = batcher.shader.glProgram;
        if (!samplerSet.has(program)) {
          const location = renderer.shader._getProgramData(program).uniformData.uMatrices?.location;
          if (location) { renderer.gl.uniform1i(location, unit); samplerSet.add(program); }
        }
      }
      return adaptorExecute.call(this, batchPipe, batch);
    };
    adaptor.execute = executeInstanced;
  }
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
  const restore = () => {
    if (pipe._initBatchableMesh === initializeVector) pipe._initBatchableMesh = initialize;
    if (batches.upload === uploadVector) batches.upload = upload;
    if (batches.buildStart === startRanges) batches.buildStart = buildStart;
    if (executeInstanced && adaptor.execute === executeInstanced) adaptor.execute = adaptorExecute;
    if (addGraphicsVector && graphicsPipe._addToBatcher === addGraphicsVector) graphicsPipe._addToBatcher = addGraphics;
    for (const set of Object.values(batches._batchersByInstructionSet)) {
      const batch = set.default, hook = defaultHooks.get(batch);
      if (hook && batch.updateElement === hook.wrapper) batch.updateElement = hook.update;
    }
    ranges?.restore();
    instancedTransforms = false;
  };
  restore.instanced = instancedTransforms;
  restore.traceInputs = on => { VectorBatcher.traceInputs = on; if (on) VectorBatcher.inputDiffs = {}; return VectorBatcher.inputDiffs; };
  return restore;
}
