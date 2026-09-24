import { GraphicsContext } from "pixi.js";
import { readAttribute } from "./display-list-data.mjs";

// Away line geometry expands each segment to four vertices and two triangles.
// Only complete segment ranges qualify; leave arbitrary meshes on the old path.
export function lineSegments(shape) {
  const e = shape.elements,
    d = e.dimension;
  const start = (shape.offset || 0) * 3;
  const indices =
    e.indices && readAttribute(e.indices, e.indices.dimensions, true);
  const count = shape.count ? shape.count * 3 : (indices?.length || 0) - start;
  if (
    ![2, 3].includes(d) ||
    !indices ||
    start % 6 ||
    count % 6 ||
    start < 0 ||
    count < 0 ||
    start + count > indices.length
  )
    return null;
  const p = readAttribute(e.positions);
  const segments = [];
  for (let i = start; i < start + count; i += 6) {
    const v = indices[i];
    if (
      v % 4 ||
      indices[i + 1] !== v + 1 ||
      indices[i + 2] !== v + 2 ||
      indices[i + 3] !== v + 3 ||
      indices[i + 4] !== v + 2 ||
      indices[i + 5] !== v + 1 ||
      v + 3 >= e.positions.count
    )
      return null;
    const at = v * d * 2;
    const segment = [p[at], p[at + 1], p[at + d], p[at + d + 1]];
    if (!segment.every(Number.isFinite)) return null;
    segments.push(segment);
  }
  return segments;
}

export function createPixelLineCache(tracker, stats) {
  const sources = new Map();
  stats.pixelLineBuilds = stats.pixelLineEntries = 0;
  const release = (entry) => {
    if (entry) entry.users--;
  };
  return {
    sync(current, shape) {
      const e = shape.elements;
      const key = `${shape.offset || 0}:${shape.count || 0}`;
      let variants = sources.get(e);
      if (!variants) sources.set(e, (variants = new Map()));
      let entry = variants.get(key);
      if (!entry) {
        entry = { users: 0, signature: null, context: null };
        variants.set(key, entry);
      }
      const signature = [e.dimension];
      for (const v of [e.positions, e.indices]) {
        signature.push(v);
        if (v)
          signature.push(
            tracker.version(v.attributesBuffer),
            v.attributesBuffer.buffer,
            v.attributesBuffer.stride,
            v.offset,
            v.dimensions,
            v.size,
            v.count,
          );
      }
      if (
        !entry.signature ||
        signature.some((v, i) => v !== entry.signature[i])
      ) {
        const segments = lineSegments(shape);
        if (segments) {
          if (!entry.context) {
            entry.context = new GraphicsContext();
            stats.pixelLineEntries++;
          }
          entry.context.clear();
          for (const [x, y, x2, y2] of segments)
            entry.context.moveTo(x, y).lineTo(x2, y2);
          entry.context.stroke({ color: 0xffffff, width: 1, pixelLine: true });
          stats.pixelLineBuilds++;
        }
        entry.valid = !!segments;
        entry.signature = signature;
      }
      if (!entry.valid) return null;
      if (entry !== current) {
        entry.users++;
        release(current);
      }
      return entry;
    },
    release,
    sweep() {
      for (const [source, variants] of sources) {
        for (const [key, entry] of variants)
          if (!entry.users) {
            if (entry.context) {
              entry.context.destroy();
              stats.pixelLineEntries--;
            }
            variants.delete(key);
          }
        if (!variants.size) sources.delete(source);
      }
    },
    destroy() {
      for (const variants of sources.values())
        for (const entry of variants.values()) entry.context?.destroy();
      sources.clear();
      stats.pixelLineEntries = 0;
    },
  };
}
