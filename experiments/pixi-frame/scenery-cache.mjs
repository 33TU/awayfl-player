// Rasterize only stable, opaque-composition vector branches. Keep text and
// effect/mask groups on their existing paths. No additional scene traversal.
export function createSceneryCache(stats, changed) {
  const entries = new Map();
  const budget = 8 * 1024 * 1024; // Retained texture texels; excludes MSAA/pool overhead.
  Object.assign(stats, { sceneryCaches: 0, sceneryPixels: 0, sceneryBuilds: 0, sceneryMeshesCached: 0,
    sceneryCandidates: 0, sceneryWarming: 0, sceneryRejected: 0 });
  function uncache(r, entry) {
    if (!entry.pixels) return;
    r.content.cacheAsTexture(false);
    stats.sceneryPixels -= entry.pixels;
    entry.pixels = 0;
    changed();
  }
  function ancestorCached(r) {
    for (let p = r.content.parent; p; p = p.parent)
      if (p.isCachedAsTexture) return true;
    return false;
  }
  function release(r) {
    const entry = entries.get(r);
    if (!entry) return;
    uncache(r, entry);
    entries.delete(r);
  }
  return {
    inspect() {
      return Array.from(entries, ([r, entry]) => ({
        name: r.node?.name, meshes: r.drawCost,
        stableFrames: stats.frames - entry.since,
        pixels: entry.pixels, rejected: !!entry.rejected,
        lastChange: r.lastChange,
      }));
    },
    observe(r) {
      if (!r.rasterSafe || r.hasText || r.drawCost < 64 || !r.outer.visible) {
        release(r);
        return;
      }
      let entry = entries.get(r);
      const resolution = Math.max(Math.hypot(r.world.a, r.world.b), Math.hypot(r.world.c, r.world.d));
      if (!entry) entries.set(r, entry = { revision: r.revision, resolution, since: stats.frames, pixels: 0 });
      if (entry.revision !== r.revision || entry.resolution !== resolution) {
        uncache(r, entry);
        entry.revision = r.revision;
        entry.resolution = resolution;
        entry.rejected = false;
        entry.since = stats.frames;
      }
    },
    prepare() {
      // Outermost eligible groups replace their nested caches. Only candidates
      // are examined here, never the full Flash object/mesh tree.
      const ready = [];
      stats.sceneryCandidates = entries.size;
      stats.sceneryWarming = stats.sceneryRejected = 0;
      for (const [r, entry] of entries) {
        if (stats.frames - entry.since < 24) { stats.sceneryWarming++; continue; }
        let depth = 0, visible = true;
        for (let p = r.outer; p; p = p.parent) { depth++; visible &&= p.visible; }
        if (visible && r.outer.parent) ready.push({ r, entry, depth });
        else uncache(r, entry);
      }
      ready.sort((a, b) => a.depth - b.depth);
      for (const { r, entry } of ready) {
        if (ancestorCached(r)) { uncache(r, entry); continue; }
        if (entry.pixels || entry.rejected) continue;
        const b = r.content.getLocalBounds();
        const resolution = Math.max(Math.hypot(r.world.a, r.world.b), Math.hypot(r.world.c, r.world.d));
        const width = Math.ceil(b.width * resolution) + 2, height = Math.ceil(b.height * resolution) + 2;
        // Pixi's pool rounds backing textures to powers of two.
        const pixels = 2 ** Math.ceil(Math.log2(width)) * 2 ** Math.ceil(Math.log2(height));
        if (!(resolution > 0 && width > 2 && height > 2) || !Number.isFinite(pixels) || width > 4096 || height > 4096 || pixels > budget / 2) {
          entry.rejected = true;
          continue;
        }
        if (stats.sceneryPixels + pixels > budget) continue;
        r.content.cacheAsTexture({ resolution, antialias: true });
        entry.pixels = pixels;
        stats.sceneryPixels += pixels;
        stats.sceneryBuilds++;
        changed();
      }
      stats.sceneryCaches = stats.sceneryMeshesCached = 0;
      for (const [r, entry] of entries) {
        if (entry.rejected) stats.sceneryRejected++;
        if (entry.pixels) {
          stats.sceneryCaches++;
          stats.sceneryMeshesCached += r.drawCost;
        }
      }
    },
    release,
    destroy() {
      for (const [r, entry] of entries) uncache(r, entry);
      entries.clear();
      stats.sceneryCaches = stats.sceneryMeshesCached = 0;
      stats.sceneryCandidates = stats.sceneryWarming = stats.sceneryRejected = 0;
    },
  };
}
