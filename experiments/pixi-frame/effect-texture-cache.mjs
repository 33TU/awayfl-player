// Keep a stable filtered group as a Pixi render-group texture. RetainedEffects
// still renders the source subtree into a filter input every frame before it
// blits the retained result; a cached render group draws one batched quad and
// re-renders only after the group changes. Animated groups stay on the filter
// path: they are uncached on every revision and re-cached after a warm-up.
export function createEffectTextureCache(stats, changed, { budget = 16 * 1024 * 1024, warmup = 2 } = {}) {
  const entries = new Map();
  Object.assign(stats, { effectTextures: 0, effectTexturePixels: 0, effectTextureBuilds: 0,
    effectTextureRejected: 0, effectTextureCandidates: 0 });
  const scaleOf = r => {
    const w = r.world;
    if (!w) return 1;
    const s = Math.max(Math.hypot(w.a, w.b), Math.hypot(w.c, w.d));
    return Math.round(s * 100) / 100;
  };
  function uncache(r, entry) {
    if (!entry.pixels) return;
    r.outer.renderGroup?.disableCacheAsTexture();
    r.content.filters = r.effectCache ? [r.effectCache] : r.filters.length ? r.filters : null;
    stats.effectTexturePixels -= entry.pixels;
    stats.effectTextures--;
    entry.pixels = 0;
    changed();
  }
  function release(r) {
    const entry = entries.get(r);
    if (!entry) return;
    uncache(r, entry);
    entries.delete(r);
  }
  return {
    observe(r) {
      if (!r.cacheSafe || !r.filters.length || !r.outer.visible) {
        release(r);
        return;
      }
      const resolution = scaleOf(r);
      let entry = entries.get(r);
      if (!entry) entries.set(r, entry = { revision: r.revision, resolution, since: stats.frames, pixels: 0, rejected: false });
      if (entry.revision !== r.revision || entry.resolution !== resolution) {
        uncache(r, entry);
        entry.revision = r.revision;
        entry.resolution = resolution;
        entry.rejected = false;
        entry.since = stats.frames;
      }
    },
    prepare() {
      stats.effectTextureCandidates = entries.size;
      stats.effectTextureRejected = 0;
      for (const [r, entry] of entries) {
        if (entry.rejected) stats.effectTextureRejected++;
        if (entry.pixels || entry.rejected || stats.frames - entry.since < warmup) continue;
        if (!r.outer.parent || !(entry.resolution > 0)) continue;
        // Local bounds include filter padding (glow, blur and shadow extents).
        const b = r.outer.getLocalBounds();
        const width = Math.ceil(b.width * entry.resolution) + 2;
        const height = Math.ceil(b.height * entry.resolution) + 2;
        const pixels = 2 ** Math.ceil(Math.log2(width)) * 2 ** Math.ceil(Math.log2(height));
        if (!(width > 2 && height > 2) || !Number.isFinite(pixels) || width > 4096 || height > 4096 || pixels > budget / 2) {
          entry.rejected = true;
          continue;
        }
        if (stats.effectTexturePixels + pixels > budget) continue;
        // The group texture retains the filtered result; skip the wrapper's own copy.
        r.content.filters = r.filters;
        r.outer.cacheAsTexture({ resolution: entry.resolution, antialias: true });
        entry.pixels = pixels;
        stats.effectTexturePixels += pixels;
        stats.effectTextures++;
        stats.effectTextureBuilds++;
        changed();
      }
    },
    release,
    destroy() {
      for (const [r, entry] of entries) uncache(r, entry);
      entries.clear();
      stats.effectTextures = stats.effectTexturePixels = stats.effectTextureCandidates = stats.effectTextureRejected = 0;
    },
  };
}
