// Reuse fully built AwayFL morph geometry. Timeline ratios are 16-bit values,
// so a looping shape tween returns to identical ratios on every cycle, and
// every instance of the same morph symbol asks for the same ratios. Keep one
// built Graphics per (morph definition, ratio), shared by all instances, and
// bound the retained set with a global least-recently-used budget instead of a
// small per-instance list that a tween longer than the list defeats.
export function installMorphCache(MorphSprite, Graphics,
  { limit = 4096, budget = 96 * 1024 * 1024, steps = 0, now = () => performance.now() } = {}) {
  const states = new WeakMap();
  const buckets = new Map();
  const unused = new Map();
  const sources = new Map();
  const maxEntries = Math.max(2, limit | 0);
  const maxBytes = Math.max(0, +budget || 0);
  const quantum = steps > 0 ? Math.max(1, steps | 0) : 0;
  const stats = { hits: 0, builds: 0, buildMs: 0, evictions: 0, live: 0, bytes: 0,
    shared: 0, limit: maxEntries, budget: maxBytes, steps: quantum,
    top(count = 8) {
      return [...sources.values()].sort((a, b) => b.buildMs - a.buildMs).slice(0, count)
        .map(({ id, path, hits, builds, buildMs }) =>
          ({ id, path, hits, builds, buildMs: Math.round(buildMs * 10) / 10 }));
    } };
  const originalSetRatio = MorphSprite.prototype.setRatio;
  const originalDispose = MorphSprite.prototype.dispose;

  // Instances clone the symbol's Graphics; the morph start/end paths live on
  // the root of that sourceGraphics chain.
  function definitionOf(graphics) {
    for (let g = graphics, depth = 0; g && depth < 32; g = g.sourceGraphics, depth++)
      if (g._start && g._end) return g;
    return null;
  }

  function sourceFor(sprite, definition) {
    const id = definition.id;
    let source = sources.get(id);
    if (!source) {
      source = { id, path: '', hits: 0, builds: 0, buildMs: 0 };
      if (sources.size < 256) sources.set(id, source);
    }
    if (!source.path) {
      const names = [];
      for (let node = sprite, depth = 0; node && depth < 12;
        node = node.parent || node._parent, depth++) {
        if (node.name && node.name !== 'null') names.push(node.name);
      }
      if (names.length) source.path = names.reverse().join('/');
    }
    return source;
  }

  function estimateBytes(graphics) {
    const shapes = graphics._shapes;
    if (!Array.isArray(shapes)) return 0;
    const buffers = new Set();
    let bytes = 0;
    for (const shape of shapes) {
      const elements = shape?.elements;
      if (!elements) continue;
      // Read the fields directly: the public getters can lazily generate
      // attributes (LineElements.colors) that the renderer never asked for.
      for (const view of [elements._positions, elements._indices, elements._uvs,
        elements._thickness, elements._colors]) {
        const buffer = view?.attributesBuffer?.buffer;
        if (buffer && !buffers.has(buffer)) {
          buffers.add(buffer);
          bytes += buffer.byteLength || 0;
        }
      }
    }
    return bytes;
  }

  function destroy(entry) {
    unused.delete(entry);
    if (entry.bucket) entry.bucket.entries.delete(entry.key);
    entry.bucket = null;
    // Pooled Graphics keep their fields; never let a stale morph definition
    // leak into whatever reuses this object next.
    entry.graphics.sourceGraphics = null;
    entry.graphics.dispose();
    stats.live--;
    stats.bytes -= entry.bytes;
  }

  function bucketFor(definition) {
    let bucket = buckets.get(definition);
    if (bucket && (bucket.start !== definition._start || bucket.end !== definition._end)) {
      // The definition Graphics was recycled for a different morph.
      buckets.delete(definition);
      for (const entry of bucket.entries.values()) {
        entry.bucket = null;
        if (!entry.users) destroy(entry);
      }
      bucket.entries.clear();
      bucket = null;
    }
    if (!bucket) {
      bucket = { definition, start: definition._start, end: definition._end, entries: new Map() };
      buckets.set(definition, bucket);
    }
    return bucket;
  }

  function use(entry) {
    if (!entry.users++) unused.delete(entry);
    else stats.shared++;
  }

  function unuse(entry) {
    if (--entry.users > 0) return;
    if (!entry.bucket) destroy(entry);
    else unused.set(entry, true);
  }

  function evict() {
    for (const entry of unused.keys()) {
      if (stats.live <= maxEntries && stats.bytes <= maxBytes) break;
      destroy(entry);
      stats.evictions++;
    }
  }

  function detach(sprite, state, restoreBase) {
    states.delete(sprite);
    if (state.entry) unuse(state.entry);
    if (restoreBase && sprite._graphics !== state.base) sprite.graphics = state.base;
  }

  MorphSprite.prototype.setRatio = function (ratio) {
    const current = this._graphics;
    let state = states.get(this);
    if (state && current !== (state.entry ? state.entry.graphics : state.base)) {
      // The Graphics changed outside the morph (timeline swap or script).
      detach(this, state, false);
      state = null;
      this._ratio = undefined;
    }
    const definition = definitionOf(current);
    if (!definition) return originalSetRatio.call(this, ratio);
    if (!state) {
      state = { base: current, entry: null };
      states.set(this, state);
    }
    const quantized = quantum ? Math.round(ratio * quantum) / quantum : ratio;
    const key = quantized * 0xffff | 0;
    if (state.entry && state.entry.key === key && this._ratio === key) return;
    const bucket = bucketFor(definition);
    let entry = bucket.entries.get(key);
    if (entry) {
      stats.hits++;
      sourceFor(this, definition).hits++;
    } else {
      const graphics = Graphics.getGraphics();
      graphics.start = null;
      graphics.end = null;
      graphics.sourceGraphics = definition;
      this.graphics = graphics;
      this._ratio = undefined;
      const started = now();
      try {
        originalSetRatio.call(this, quantized);
      } catch (error) {
        this.graphics = current;
        graphics.sourceGraphics = null;
        graphics.dispose();
        this._ratio = undefined;
        throw error;
      }
      entry = { bucket, key, graphics, users: 0, bytes: estimateBytes(graphics) };
      bucket.entries.set(key, entry);
      stats.builds++;
      stats.live++;
      stats.bytes += entry.bytes;
      const elapsed = now() - started;
      stats.buildMs += elapsed;
      const source = sourceFor(this, definition);
      source.builds++;
      source.buildMs += elapsed;
    }
    if (state.entry !== entry) {
      use(entry);
      if (state.entry) unuse(state.entry);
      state.entry = entry;
    }
    if (this._graphics !== entry.graphics) this.graphics = entry.graphics;
    this._ratio = key;
    evict();
  };

  MorphSprite.prototype.dispose = function (...args) {
    const state = states.get(this);
    try { return originalDispose.apply(this, args); }
    finally {
      if (state) detach(this, state, true);
      this._ratio = undefined;
    }
  };

  return stats;
}
