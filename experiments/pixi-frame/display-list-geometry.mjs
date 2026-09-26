import { MeshGeometry } from "pixi.js";
import { triangleData, readAttribute, screenSpaceStroke } from "./display-list-data.mjs";

const same = (a, b) => a?.length === b.length && b.every((v, i) => v === a[i]);

// One geometry per source element/range/UV mapping/shader layout. Meshes retain
// independent transforms, textures and colors. No hashing of vertex contents.
export function createGeometryCache(tracker, stats, { retain = 2048 } = {}) {
  const sources = new Map();
  // Unused geometries, oldest first. Cached morph ratios bring the same
  // elements back a few frames later; keep a bounded set instead of rebuilding.
  const unused = new Map();
  const retained = Math.max(0, retain | 0);
  stats.geometryEntries = stats.geometryUsers = stats.geometryShares = stats.geometryRetained = 0;
  function release(entry) {
    if (!entry) return;
    entry.users--;
    stats.geometryUsers--;
    if (!entry.users && retained) unused.set(entry, true);
  }
  return {
    sync(current, shape, uv, custom, world) {
      const e = shape.elements;
      const curves = e.getCustomAtributes?.("curves");
      const variant = [
        custom,
        shape.count || 0,
        shape.offset || 0,
        uv?.a,
        uv?.b,
        uv?.c,
        uv?.d,
        uv?.tx,
        uv?.ty,
      ];
      if (screenSpaceStroke(e)) {
        // Translation does not change stroke extrusion. Instances at the same
        // linear transform can still share their cached geometry.
        variant.push(e.scaleMode, world?.a, world?.b, world?.c, world?.d);
      }
      // Most retained meshes keep the same source/range/UV layout. Check that
      // tuple directly instead of serializing and looking it up every frame.
      let entry =
        current?.source === e && same(current.variant, variant)
          ? current
          : null;
      if (!entry) {
        const key = JSON.stringify(variant);
        let variants = sources.get(e);
        if (!variants) sources.set(e, (variants = new Map()));
        entry = variants.get(key);
        if (!entry) {
          const geometry = new MeshGeometry();
          geometry.batchMode = custom ? "no-batch" : "batch";
          entry = { geometry, users: 0, signature: null, source: e, variant };
          variants.set(key, entry);
          stats.geometryEntries++;
        }
      }
      const signature = [e.numVertices, e.dimension, e.scaleMode];
      for (const view of [e.positions, e.indices, e.uvs, e.thickness, curves]) {
        signature.push(view);
        if (!view) continue;
        const b = view.attributesBuffer;
        signature.push(
          tracker.version(b),
          b.buffer,
          b.stride,
          view.offset,
          view.dimensions,
          view.size,
          view.count,
        );
      }
      if (!same(entry.signature, signature)) {
        const data = triangleData(shape, uv, world);
        const geometry = entry.geometry;
        geometry.positions = data.positions;
        geometry.uvs = data.uvs;
        geometry.indices = data.indices;
        if (custom) {
          const curveData = curves
            ? readAttribute(curves, 3)
            : new Float32Array((data.positions.length / 2) * 3);
          if (geometry.attributes.aCurve)
            geometry.attributes.aCurve.buffer.data = curveData;
          else
            geometry.addAttribute("aCurve", {
              buffer: curveData,
              format: "float32x3",
            });
        }
        entry.signature = signature;
        entry.revision = (entry.revision || 0) + 1;
        stats.geometryBuilds++;
      }
      if (current !== entry) {
        if (entry.users) stats.geometryShares++;
        else unused.delete(entry);
        entry.users++;
        stats.geometryUsers++;
        release(current);
      }
      return entry;
    },
    release,
    sweep() {
      // Run after rendering: old render instructions can still reference meshes
      // retired during synchronization. Other instances keep their geometry alive.
      for (const entry of unused.keys()) {
        if (unused.size <= retained) break;
        unused.delete(entry);
      }
      for (const [source, variants] of sources) {
        for (const [key, entry] of variants)
          if (!entry.users && !unused.has(entry)) {
            entry.geometry.destroy();
            variants.delete(key);
            stats.geometryEntries--;
          }
        if (!variants.size) sources.delete(source);
      }
      stats.geometryRetained = unused.size;
    },
    destroy() {
      unused.clear();
      stats.geometryRetained = 0;
      for (const variants of sources.values())
        for (const entry of variants.values()) entry.geometry.destroy();
      sources.clear();
      stats.geometryEntries = stats.geometryUsers = 0;
    },
  };
}
