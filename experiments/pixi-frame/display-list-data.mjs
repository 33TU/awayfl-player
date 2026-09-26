// CPU-only adapters. No AwayFL renderer, shader, render entity or GPU capture.
let nextTracker = 0;
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
export function createAssetTracker(onChange = () => {}) {
  const entries = new Map();
  const ownerAssets = new Map();
  let currentOwner = null, currentAssets = null;
  // A reattached tracker must not reuse an old revision after a hidden asset
  // was swept. Retained geometry may still hold that earlier revision.
  let nextRevision = 0;
  const id = "pixi-display-list-" + ++nextTracker;
  const release = (asset, r) => {
    asset.removeAbstraction(r);
    if (r.property && Object.getOwnPropertyDescriptor(asset, r.property.name)?.get === r.property.get) {
      Object.defineProperty(asset, r.property.name, { ...r.property.descriptor, value: r.property.get() });
    }
    if (r.method && asset[r.method.name] === r.method.wrapper) {
      if (r.method.descriptor)
        Object.defineProperty(asset, r.method.name, r.method.descriptor);
      else delete asset[r.method.name];
    }
  };
  return {
    version(asset, method, property, trackOwner = true) {
      if (!asset) return 0;
      let r = entries.get(asset);
      if (!r) {
        r = {
          id,
          revision: nextRevision++,
          owners: new Set(),
          listeners: new Set(),
          onInvalidate() {
            this.revision = nextRevision++;
            for (const owner of this.owners) onChange(owner);
            for (const listener of this.listeners) listener();
          },
          onClear() {
            this.revision = nextRevision++;
            for (const owner of this.owners) onChange(owner);
            for (const listener of this.listeners) listener();
          },
        };
        asset.addAbstraction(r);
        entries.set(asset, r);
      }
      if (method && !r.method) {
        const descriptor = Object.getOwnPropertyDescriptor(asset, method);
        const original = asset[method];
        const wrapper = function (...args) {
          r.onInvalidate();
          return original.apply(this, args);
        };
        asset[method] = wrapper;
        r.method = { name: method, descriptor, wrapper };
      }
      if (property && !r.property) {
        const descriptor = Object.getOwnPropertyDescriptor(asset, property) ||
          (!(property in asset) ? { configurable: true, enumerable: true, writable: true, value: undefined } : null);
        if (descriptor?.configurable && descriptor.writable && "value" in descriptor) {
          let value = descriptor.value;
          const get = () => value;
          Object.defineProperty(asset, property, {
            configurable: true, enumerable: descriptor.enumerable, get,
            set(next) {
              if (next !== value) { value = next; r.onInvalidate(); }
            },
          });
          r.property = { name: property, descriptor, get };
        }
      }
      r.epoch = this.epoch;
      if (currentOwner && trackOwner) {
        r.owners.add(currentOwner);
        currentAssets.add(asset);
      }
      return r.revision;
    },
    listen(asset, listener) {
      this.version(asset, undefined, undefined, false);
      const r = entries.get(asset);
      r.listeners.add(listener);
      return () => r.listeners.delete(listener);
    },
    beginOwner(owner) {
      currentOwner = owner;
      currentAssets = new Set();
    },
    endOwner() {
      if (!currentOwner) return;
      for (const asset of ownerAssets.get(currentOwner) || [])
        if (!currentAssets.has(asset)) entries.get(asset)?.owners.delete(currentOwner);
      ownerAssets.set(currentOwner, currentAssets);
      currentOwner = currentAssets = null;
    },
    releaseOwner(owner) {
      for (const asset of ownerAssets.get(owner) || []) entries.get(asset)?.owners.delete(owner);
      ownerAssets.delete(owner);
    },
    retained(asset) { return !!entries.get(asset)?.owners.size; },
    epoch: 0,
    sweep() {
      for (const [asset, r] of entries)
        if (!r.owners.size && !r.listeners.size && r.epoch < this.epoch - 2) {
          release(asset, r);
          entries.delete(asset);
        }
    },
    destroy() {
      for (const [asset, r] of entries) release(asset, r);
      entries.clear();
      ownerAssets.clear();
      currentOwner = currentAssets = null;
    },
  };
}

export function readAttribute(
  view,
  dimensions = view.dimensions,
  integer = false,
) {
  const buffer = view.attributesBuffer.buffer;
  const stride = view.attributesBuffer.stride;
  const count = view.count;
  const length = count * dimensions;
  const result = integer
    ? new Uint32Array(length)
    : new Float32Array(length);
  // SWF geometry usually stores aligned 32-bit components. Read those through
  // a typed array so animated morphs do not make a DataView call per component.
  // Copy into result: triangleData adjusts positions and UVs in place.
  const componentBytes = integer && view.size === 2 ? 2 : 4;
  if (littleEndian && count && view.offset >= 0 && stride >= 0 &&
      view.offset % componentBytes === 0 && stride % componentBytes === 0 &&
      (view.size === 4 || (integer && view.size === 2)) &&
      (count - 1) * stride + view.offset + dimensions * componentBytes <= buffer.byteLength) {
    const source = integer
      ? view.size === 2
        ? new Uint16Array(buffer, 0, Math.floor(buffer.byteLength / 2))
        : new Uint32Array(buffer, 0, Math.floor(buffer.byteLength / 4))
      : new Float32Array(buffer, 0, Math.floor(buffer.byteLength / 4));
    const sourceStride = stride / componentBytes;
    let sourceAt = view.offset / componentBytes;
    if (sourceStride === dimensions) {
      result.set(source.subarray(sourceAt, sourceAt + length));
    } else {
      for (let i = 0, targetAt = 0; i < count; i++, sourceAt += sourceStride)
        for (let j = 0; j < dimensions; j++) result[targetAt++] = source[sourceAt + j];
    }
    return result;
  }
  const bytes = new DataView(buffer);
  for (let i = 0; i < count; i++)
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

// AwayJS LineScaleMode: NONE=1, NORMAL=2, HAIRLINE=4.
export function screenSpaceStroke(e) {
  return e.assetType === "[asset LineElements]" &&
    (e.scaleMode === 1 || e.scaleMode === 4);
}

export function triangleData(shape, uvMatrix, world) {
  const e = shape.elements;
  const line = e.assetType === "[asset LineElements]";
  const positions = readAttribute(e.positions, 2);
  // Extrude fixed-width strokes in render pixels, then map the offset back
  // to local space. This keeps enlarged previews from enlarging hairlines.
  if (line) {
    const endpoints = readAttribute(e.positions);
    const thickness = readAttribute(e.thickness);
    const dims = e.dimension;
    const screen = screenSpaceStroke(e) && world;
    // Matrix components are getters over rawData; read them once, not per segment.
    const wa = screen ? world.a : 1, wb = screen ? world.b : 0, wc = screen ? world.c : 0, wd = screen ? world.d : 1;
    const determinant = screen ? wa * wd - wb * wc : 0;
    const side = Math.sign(determinant);
    for (let i = 0; i < positions.length / 2; i++) {
      const at = i * dims * 2;
      let dx = endpoints[at + dims] - endpoints[at];
      let dy = endpoints[at + dims + 1] - endpoints[at + 1];
      if (screen) {
        const sx = wa * dx + wc * dy, sy = wb * dx + wd * dy;
        dx = sx; dy = sy;
      }
      const len = Math.hypot(dx, dy);
      if (len) {
        let ox = (dy / len) * thickness[i];
        let oy = -(dx / len) * thickness[i];
        if (screen) {
          if (Math.abs(determinant) < 1e-12) continue;
          // Preserve the side of the stroke under reflected transforms.
          const lx = side * (wd * ox - wc * oy) / determinant;
          const ly = side * (-wb * ox + wa * oy) / determinant;
          ox = lx; oy = ly;
        }
        positions[i * 2] += ox;
        positions[i * 2 + 1] += oy;
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
