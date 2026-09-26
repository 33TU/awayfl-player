import { Matrix, RenderTexture } from "pixi.js";

// First synchronous BitmapData.draw bridge. The two renderers own different GL
// contexts, so this deliberately reads the Pixi target back into AwayFL's CPU
// bitmap. Only replace draws whose entire destination is transparent/unused.
export function createBitmapDraw(renderer, records, stats) {
  function preparedTree(node, root) {
    const record = records.get(node);
    if (!record) return "missing-record:" + node.name;
    // Incremental preparation can reuse an unchanged branch without touching
    // its descendants' epoch; their retained Pixi objects are still current.
    if (node === root && record.epoch !== stats.frames - 1)
      return "stale-root:" + node.name;
    if (record.branchDirty || record.selfDirty || record.descendantsDirty)
      return "dirty-record:" + node.name;
    for (const mask of record.maskNodes || []) {
      let owner = mask;
      while (owner && owner !== root) owner = owner.parent;
      if (!owner) return "external-mask:" + node.name;
    }
    // Invisible children do not contribute, and Pixi does not prepare their
    // descendants until they become visible again.
    for (const child of node._children || [])
      if (child.visible !== false) {
        const reason = preparedTree(child, root);
        if (reason) return reason;
      }
    return null;
  }
  return function draw(bitmap, source, matrix, colorTransform, blendMode, clipRect) {
    const record = records.get(source);
    const treeReason = preparedTree(source, source);
    if (treeReason) { stats.pixiBitmapDrawLastSkip = treeReason; return false; }
    if (!record.outer.visible || source.mask || source.filters?.length ||
        colorTransform || (blendMode && blendMode !== "normal" && blendMode !== "layer") ||
        (clipRect && (clipRect.x !== 0 || clipRect.y !== 0 ||
          clipRect.width !== bitmap.width || clipRect.height !== bitmap.height)) ||
        !bitmap.transparent || bitmap._initalFillColor == null ||
        (bitmap._initalFillColor >>> 24) !== 0 ||
        bitmap._imageDataDirty || bitmap.wasUpload || bitmap._data ||
        !(bitmap.width > 0 && bitmap.height > 0) ||
        bitmap.width > 2048 || bitmap.height > 2048)
      { stats.pixiBitmapDrawLastSkip = "unsupported-draw-options"; return false; }
    const values = matrix ? [matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty]
      : [1, 0, 0, 1, 0, 0];
    if (!values.every(Number.isFinite)) return false;
    const target = RenderTexture.create({ width: bitmap.width, height: bitmap.height });
    try {
      renderer.render({ container: record.outer, target,
        transform: new Matrix(...values), clear: true, clearColor: [0, 0, 0, 0] });
      const { pixels, width, height } = renderer.extract.pixels(target);
      if (width !== bitmap.width || height !== bitmap.height) return false;
      bitmap.unmarkToUnload();
      const data = bitmap.getDataInternal(true, true);
      data.set(pixels);
      bitmap._initalFillColor = null;
      bitmap._lastUsedFill = null;
      bitmap._unpackPMA = false;
      bitmap._imageDataDirty = false;
      bitmap.invalidateGPU();
      bitmap.invalidateOwners();
      stats.pixiBitmapDraws++;
      return true;
    } catch (error) {
      stats.pixiBitmapDrawLastError = String(error);
      return false;
    } finally {
      target.destroy(true);
    }
  };
}
