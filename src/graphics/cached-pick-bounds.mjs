// Reuse local bounds for immutable/revisited triangle geometry. AwayFL's
// picking normally scans every vertex when a picker is reconstructed, even if
// a retained morph ratio brings back the exact same TriangleElements object.
export function installCachedPickBounds(TriangleElements, Box) {
  const original = TriangleElements.prototype.getBoxBounds;
  const records = new WeakMap();
  const stats = { hits: 0, misses: 0, invalidations: 0 };
  let nextId = 0;

  function detach(elements, record) {
    for (const asset of record.assets) asset.removeAbstraction(record.guard);
    records.delete(elements);
  }

  TriangleElements.prototype.getBoxBounds = function (
    node, strokeFlag, matrix3D, cache, target, count = 0, offset = 0
  ) {
    // Matrices and partial ranges retain AwayFL's exact implementation.
    if (matrix3D || target || count || offset) {
      return original.call(this, node, strokeFlag, matrix3D, cache, target, count, offset);
    }
    const positions = this.positions?.attributesBuffer;
    const indices = this.indices?.attributesBuffer;
    if (!positions || typeof positions.addAbstraction !== 'function' ||
        typeof this.addAbstraction !== 'function') {
      return original.call(this, node, strokeFlag, matrix3D, cache, target, count, offset);
    }
    let record = records.get(this);
    if (record && (record.positions !== positions || record.indices !== indices ||
        record.count !== this._numElements || record.vertices !== this._numVertices)) {
      detach(this, record);
      record = null;
    }
    if (record?.box) {
      stats.hits++;
      const box = cache || new Box();
      box.x = record.box.x; box.y = record.box.y; box.z = record.box.z;
      box.width = record.box.width; box.height = record.box.height; box.depth = record.box.depth;
      return box;
    }
    const result = original.call(this, node, strokeFlag, matrix3D, cache, target, count, offset);
    stats.misses++;
    if (!result) return result;
    if (!record) {
      record = { positions, indices, count: this._numElements,
        vertices: this._numVertices, assets: [], box: null, guard: null };
      const elements = this;
      record.guard = {
        id: 'pixi-pick-bounds-' + ++nextId,
        onInvalidate() { record.box = null; stats.invalidations++; },
        onClear() { detach(elements, record); },
      };
      for (const asset of [this, positions, indices]) {
        if (!asset || record.assets.includes(asset)) continue;
        asset.addAbstraction(record.guard);
        record.assets.push(asset);
      }
      records.set(this, record);
    }
    record.box = { x: result.x, y: result.y, z: result.z,
      width: result.width, height: result.height, depth: result.depth };
    return result;
  };
  return stats;
}
