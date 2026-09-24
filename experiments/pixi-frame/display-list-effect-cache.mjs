import { AlphaFilter, TexturePool } from "pixi.js";

// Retain normal filter output, not the backdrop. Source geometry still renders
// into Pixi's input target; unchanged effects then require only a texture copy.
// Advanced blends and externally masked subtrees must stay outside this cache.
export class RetainedEffects extends AlphaFilter {
  constructor(filters, stats) {
    super({
      alpha: 1,
      padding: filters.reduce((n, f) => n + f.padding, 0),
      resolution: filters.reduce(
        (n, f) => (f.resolution === "inherit" ? n : Math.min(n, f.resolution)),
        1,
      ),
    });
    this.effects = filters;
    this.stats = stats;
    this.revision = 0;
  }

  release() {
    if (!this.cached) return;
    this.stats.effectCachePixels -= this.pixels;
    TexturePool.returnTexture(this.cached);
    this.cached = null;
  }

  apply(manager, input, output, clearMode) {
    const b = manager._activeFilterData.bounds;
    const key = [
      this.revision,
      input.frame.width,
      input.frame.height,
      input.source.resolution,
      b.minX,
      b.minY,
      b.maxX,
      b.maxY,
    ].join(":");
    if (this.cached && key === this.key) {
      this.stats.effectCacheHits++;
      manager.applyFilter(this, this.cached, output, clearMode);
      return;
    }
    const changing =
      this.lastInputKey !== undefined && this.lastInputKey !== key;
    this.lastInputKey = key;
    this.release();
    // Bound persistent GPU memory to 64 MiB and 32 MiB per effect group.
    const pixels = input.source.pixelWidth * input.source.pixelHeight;
    const retain =
      !changing &&
      pixels <= 8 * 1024 * 1024 &&
      this.stats.effectCachePixels + pixels <= 16 * 1024 * 1024;
    if (!retain) {
      // Continuously animated effects and oversized groups use the normal chain,
      // avoiding a retained texture and an extra copy on every animation frame.
      const targets = [];
      try {
        for (let i = 0; i < Math.min(2, this.effects.length - 1); i++)
          targets.push(TexturePool.getSameSizeTexture(input));
        let source = input;
        for (let i = 0; i < this.effects.length; i++) {
          const last = i === this.effects.length - 1;
          const dest = last ? output : targets[i % 2];
          this.effects[i].apply(manager, source, dest, last ? clearMode : true);
          this.stats.effectPasses++;
          source = dest;
        }
      } finally {
        for (const target of targets) TexturePool.returnTexture(target);
      }
      return;
    }
    const target = TexturePool.getSameSizeTexture(input);
    let temporary;
    try {
      if (this.effects.length > 1)
        temporary = TexturePool.getSameSizeTexture(input);
      let source = input;
      for (let i = 0; i < this.effects.length; i++) {
        const dest = (this.effects.length - 1 - i) % 2 ? temporary : target;
        this.effects[i].apply(manager, source, dest, true);
        this.stats.effectPasses++;
        source = dest;
      }
      manager.applyFilter(this, target, output, clearMode);
      this.stats.effectCacheBuilds++;
      if (retain) {
        this.cached = target;
        this.key = key;
        this.pixels = pixels;
        this.stats.effectCachePixels += pixels;
      }
    } finally {
      if (temporary) TexturePool.returnTexture(temporary);
      if (this.cached !== target) TexturePool.returnTexture(target);
    }
  }

  destroy() {
    this.release();
    super.destroy();
  }
}
