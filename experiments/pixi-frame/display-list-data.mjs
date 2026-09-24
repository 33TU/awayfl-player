// CPU-only adapters. No AwayFL renderer, shader, render entity or GPU capture.
let nextTracker = 0;
export function createAssetTracker() {
  const entries = new Map();
  // A reattached tracker must not reuse an old revision after a hidden asset
  // was swept. Retained geometry may still hold that earlier revision.
  let nextRevision = 0;
  const id = "pixi-display-list-" + ++nextTracker;
  const release = (asset, r) => {
    asset.removeAbstraction(r);
    if (r.method && asset[r.method.name] === r.method.wrapper) {
      if (r.method.descriptor)
        Object.defineProperty(asset, r.method.name, r.method.descriptor);
      else delete asset[r.method.name];
    }
  };
  return {
    version(asset, method) {
      if (!asset) return 0;
      let r = entries.get(asset);
      if (!r) {
        r = {
          id,
          revision: nextRevision++,
          onInvalidate() {
            this.revision = nextRevision++;
          },
          onClear() {
            this.revision = nextRevision++;
          },
        };
        asset.addAbstraction(r);
        entries.set(asset, r);
      }
      if (method && !r.method) {
        const descriptor = Object.getOwnPropertyDescriptor(asset, method);
        const original = asset[method];
        const wrapper = function (...args) {
          r.revision = nextRevision++;
          return original.apply(this, args);
        };
        asset[method] = wrapper;
        r.method = { name: method, descriptor, wrapper };
      }
      r.epoch = this.epoch;
      return r.revision;
    },
    epoch: 0,
    sweep() {
      for (const [asset, r] of entries)
        if (r.epoch < this.epoch - 2) {
          release(asset, r);
          entries.delete(asset);
        }
    },
    destroy() {
      for (const [asset, r] of entries) release(asset, r);
      entries.clear();
    },
  };
}

export function readAttribute(
  view,
  dimensions = view.dimensions,
  integer = false,
) {
  const bytes = new DataView(view.attributesBuffer.buffer);
  const stride = view.attributesBuffer.stride;
  const result = integer
    ? new Uint32Array(view.count * dimensions)
    : new Float32Array(view.count * dimensions);
  for (let i = 0; i < view.count; i++)
    for (let j = 0; j < dimensions; j++) {
      const at = i * stride + view.offset + j * view.size;
      result[i * dimensions + j] = integer
        ? view.size === 2
          ? bytes.getUint16(at, true)
          : bytes.getUint32(at, true)
        : view.size === 4
          ? bytes.getFloat32(at, true)
          : bytes.getInt8(at);
    }
  return result;
}

export function triangleData(shape, uvMatrix) {
  const e = shape.elements;
  const line = e.assetType === "[asset LineElements]";
  const positions = readAttribute(e.positions, 2);
  // Ordinary scaled 2D strokes. Hairline and non-scaling modes are reported by
  // the caller until screen-space extrusion is implemented.
  if (line) {
    const endpoints = readAttribute(e.positions);
    const thickness = readAttribute(e.thickness);
    const dims = e.dimension;
    for (let i = 0; i < positions.length / 2; i++) {
      const at = i * dims * 2;
      const dx = endpoints[at + dims] - endpoints[at];
      const dy = endpoints[at + dims + 1] - endpoints[at + 1];
      const len = Math.hypot(dx, dy);
      if (len) {
        positions[i * 2] += (dy / len) * thickness[i];
        positions[i * 2 + 1] -= (dx / len) * thickness[i];
      }
    }
  }
  const indices = e.indices
    ? readAttribute(e.indices, e.indices.dimensions, true)
    : Uint32Array.from({ length: positions.length / 2 }, (_, i) => i);
  const start = (shape.offset || 0) * (e.indices ? 3 : 1);
  const count = shape.count
    ? shape.count * (e.indices ? 3 : 1)
    : indices.length - start;
  if (start < 0 || count < 0 || start + count > indices.length)
    throw Error("Invalid display-list geometry range");
  const uvs = e.uvs && !line ? readAttribute(e.uvs, 2) : positions.slice();
  if (uvMatrix)
    for (let i = 0; i < uvs.length; i += 2) {
      const x = uvs[i],
        y = uvs[i + 1];
      uvs[i] = x * uvMatrix.a + y * uvMatrix.c + uvMatrix.tx;
      uvs[i + 1] = x * uvMatrix.b + y * uvMatrix.d + uvMatrix.ty;
    }
  return { positions, uvs, indices: indices.slice(start, start + count) };
}

export function combineColor(parent, local, out = new Float32Array(8)) {
  for (let i = 0; i < 4; i++) {
    out[i] = parent[i] * (local?.[i] ?? 1);
    out[i + 4] = parent[i + 4] + parent[i] * (local?.[i + 4] ?? 0);
  }
  return out;
}
