// Merge adjacent triangle recipes without reordering them. Each vertex carries
// its draw number; the vertex shader reads that draw's packed transform constants.
// Fragment uniforms stay shared and unchanged, avoiding per-pixel lookups.
export function createMeshBatcher({
  vertexVectors,
  attributes,
  limit = 16,
  maxVertices = 65536,
}) {
  const programs = new Map(),
    geometries = new Map();
  let epoch = 0;
  const stats = {
    input: 0,
    output: 0,
    batches: 0,
    merged: 0,
    geometryBuilds: 0,
  };
  function program(g) {
    const vc = g.uniforms.vc;
    if (!vc || vc.type !== 35666 || !Number.isInteger(vc.size) || vc.size <= 0)
      return null;
    let fragments = programs.get(g.vertex);
    if (!fragments) programs.set(g.vertex, (fragments = new Map()));
    if (fragments.has(g.fragment)) {
      const saved = fragments.get(g.fragment);
      return saved?.vcSize === vc.size ? saved : null;
    }
    const reject = () => {
      fragments.set(g.fragment, null);
      return null;
    };
    if (
      !g.vertex.startsWith("#version 300 es") ||
      !g.fragment.startsWith("#version 300 es") ||
      Object.keys(g.attributes).length >= attributes ||
      /AwayBatch|gl_VertexID|gl_InstanceID/.test(g.vertex + g.fragment)
    )
      return reject();
    if (/\bvc\b/.test(g.fragment)) return reject();
    const declaration = new RegExp(
      `uniform\\s+(?:(?:lowp|mediump|highp)\\s+)?vec4\\s+vc\\s*\\[\\s*${vc.size}\\s*\\]\\s*;`,
    );
    if (!declaration.test(g.vertex)) return reject();
    // Reserve space for Pixi's projection uniforms; unfamiliar vertex uniforms
    // stay on the original path rather than exceeding the device's limit.
    if (/\buniform\b/.test(g.vertex.replace(declaration, ""))) return reject();
    const capacity = Math.min(
      limit,
      Math.floor((vertexVectors - 16) / vc.size),
    );
    if (capacity < 2) return reject();
    let vertex = g.vertex
      .replace(
        declaration,
        `uniform vec4 uAwayBatch_vc[${vc.size * capacity}];`,
      )
      .replace(
        /\bvc\s*\[([^\[\]]+)\]/g,
        (_, index) =>
          `uAwayBatch_vc[int(aAwayBatchId + 0.5) * ${vc.size} + (${index})]`,
      );
    if (/\bvc\b/.test(vertex)) return reject();
    vertex = vertex.replace(
      "#version 300 es",
      "#version 300 es\nin float aAwayBatchId;",
    );
    const fragment = g.fragment;
    const result = {
      vertex,
      fragment,
      capacity,
      vcSize: vc.size,
      variants: new Map(),
    };
    fragments.set(g.fragment, result);
    return result;
  }
  function sameObject(a, b, equal = (x, y) => x === y) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k], k))
    );
  }
  function compatible(a, b) {
    return (
      a.vertex === b.vertex &&
      a.fragment === b.fragment &&
      a.blend === b.blend &&
      a.offscreen === b.offscreen &&
      a.nativeProjection === b.nativeProjection &&
      sameObject(a.viewport, b.viewport) &&
      sameObject(a.attributes, b.attributes, (x, y) => x.size === y.size) &&
      sameObject(
        a.uniforms,
        b.uniforms,
        (x, y, name) =>
          x.type === y.type &&
          x.size === y.size &&
          (name === "vc" ||
            (typeof x.value === "number"
              ? x.value === y.value
              : x.value.length === y.value.length &&
                x.value.every((v, i) => v === y.value[i]))),
      ) &&
      sameObject(
        a.samplers,
        b.samplers,
        (x, y) =>
          x.handle === y.handle &&
          x.scaleMode === y.scaleMode &&
          x.addressMode === y.addressMode,
      ) &&
      ((!a.raster && !b.raster) ||
        (a.raster &&
          b.raster &&
          sameObject(a.raster, b.raster, (x, y) =>
            Array.isArray(x)
              ? x.length === y.length && x.every((v, i) => v === y[i])
              : x === y,
          )))
    );
  }
  function merge(entries, description) {
    const first = entries[0],
      g = first.recipe;
    const capacity = Math.min(
      description.capacity,
      2 ** Math.ceil(Math.log2(entries.length)),
    );
    if (capacity !== description.capacity) {
      let variant = description.variants.get(capacity);
      if (!variant) {
        variant = {
          ...description,
          capacity,
          vertex: description.vertex.replace(
            `uAwayBatch_vc[${g.uniforms.vc.size * description.capacity}]`,
            `uAwayBatch_vc[${g.uniforms.vc.size * capacity}]`,
          ),
        };
        description.variants.set(capacity, variant);
      }
      description = variant;
    }
    const count = entries.reduce((sum, e) => sum + e.recipe.count, 0);
    let cached = geometries.get(first.key);
    if (
      !cached ||
      cached.inputs.length !== entries.length ||
      !entries.every(
        (e, i) =>
          e.recipe.count === cached.inputs[i].count &&
          sameObject(
            e.recipe.attributes,
            cached.inputs[i].attributes,
            (x, y) => x.size === y.size && x.data === y.data,
          ),
      )
    ) {
      const attributes = {};
      for (const [name, a] of Object.entries(g.attributes)) {
        const data = new Float32Array(count * a.size);
        let offset = 0;
        for (const e of entries) {
          data.set(e.recipe.attributes[name].data, offset);
          offset += e.recipe.count * a.size;
        }
        attributes[name] = { size: a.size, data };
      }
      const ids = new Float32Array(count);
      let offset = 0;
      entries.forEach((e, i) => {
        ids.fill(i, offset, offset + e.recipe.count);
        offset += e.recipe.count;
      });
      attributes.aAwayBatchId = { size: 1, data: ids };
      cached = {
        attributes,
        inputs: entries.map((e) => ({
          count: e.recipe.count,
          attributes: e.recipe.attributes,
        })),
      };
      geometries.set(first.key, cached);
      stats.geometryBuilds++;
    }
    cached.epoch = epoch;
    const uniforms = {};
    for (const [name, u] of Object.entries(g.uniforms)) {
      if (name !== "vc") {
        uniforms[name] = u;
        continue;
      }
      const value = new Float32Array(u.size * 4 * description.capacity);
      entries.forEach((e, i) =>
        value.set(e.recipe.uniforms[name].value, i * u.size * 4),
      );
      uniforms["uAwayBatch_" + name] = {
        type: u.type,
        size: u.size * description.capacity,
        value,
      };
    }
    let left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity;
    for (const { recipe } of entries) {
      const b = recipe.bounds || recipe.viewport;
      left = Math.min(left, b.x);
      top = Math.min(top, b.y);
      right = Math.max(right, b.x + b.width);
      bottom = Math.max(bottom, b.y + b.height);
    }
    stats.batches++;
    stats.merged += entries.length - 1;
    return {
      key: first.key,
      recipe: {
        ...g,
        vertex: description.vertex,
        fragment: description.fragment,
        attributes: cached.attributes,
        count,
        uniforms,
        bounds: { x: left, y: top, width: right - left, height: bottom - top },
      },
    };
  }
  return {
    stats,
    begin() {
      epoch++;
      stats.input = stats.output = stats.batches = stats.merged = 0;
      for (const [key, value] of geometries)
        if (epoch - value.epoch > 120) geometries.delete(key);
    },
    batch(entries) {
      const out = [];
      let pending = [],
        vertices = 0,
        description;
      const flush = () => {
        if (pending.length)
          out.push(
            pending.length > 1 ? merge(pending, description) : pending[0],
          );
        pending = [];
        vertices = 0;
      };
      for (const e of entries) {
        const g = e.recipe,
          p = program(g);
        if (!p || !g.count || g.count % 3) {
          flush();
          out.push(e);
          continue;
        }
        if (
          pending.length &&
          (pending.length >= description.capacity ||
            vertices + g.count > maxVertices ||
            !compatible(pending[0].recipe, g))
        )
          flush();
        if (!pending.length) description = p;
        pending.push(e);
        vertices += g.count;
      }
      flush();
      stats.input += entries.length;
      stats.output += out.length;
      return out;
    },
    destroy() {
      geometries.clear();
      programs.clear();
    },
  };
}
