import { Matrix, RenderTexture } from "pixi.js";

// Flash ColorTransform (multipliers and 0..255 offsets) from an AwayFL or AS3
// object; null when it cannot be read.
function readColorTransform(t) {
  const raw = t._rawData || t.adaptee?._rawData;
  const v = raw?.length === 8 ? Array.from(raw)
    : ["redMultiplier", "greenMultiplier", "blueMultiplier", "alphaMultiplier",
       "redOffset", "greenOffset", "blueOffset", "alphaOffset"].map(k => t[k] ?? t["$Bg" + k]);
  return v.every(Number.isFinite) ? v : null;
}
// Pixels read back from a render target are premultiplied RGBA. Apply the
// transform to straight colour, as Flash does, then premultiply again.
function applyColorTransform(data, [rm, gm, bm, am, ro, go, bo, ao]) {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (!a && !ao) continue;
    const inv = a ? 255 / a : 0;
    const r = data[i] * inv, g = data[i + 1] * inv, b = data[i + 2] * inv;
    const na = Math.max(0, Math.min(255, a * am + ao)), k = na / 255;
    data[i] = Math.max(0, Math.min(255, r * rm + ro)) * k;
    data[i + 1] = Math.max(0, Math.min(255, g * gm + go)) * k;
    data[i + 2] = Math.max(0, Math.min(255, b * bm + bo)) * k;
    data[i + 3] = na;
  }
}

// First synchronous BitmapData.draw bridge. The two renderers own different GL
// contexts, so this deliberately reads the Pixi target back into AwayFL's CPU
// bitmap. Only replace draws whose entire destination is transparent/unused.
export function createBitmapDraw(renderer, records, stats) {
  function preparedTree(node, root) {
    const record = records.get(node);
    if (!record) return "missing-record:" + node.name;
    // Incremental preparation can reuse an unchanged branch without touching
    // its descendants' epoch; their retained Pixi objects are still current.
    // A retained branch is not revisited, so its epoch can be old while its
    // Pixi objects are current; the dirty checks below cover its own subtree.
    // Ancestors do not matter: the draw supplies its own matrix, and a parent
    // made dirty by a new sibling (the previous cooldown overlay added to the
    // action bar) does not change this branch.
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
    // A colour transform is applied to the read-back pixels below. Skill
    // cooldowns draw a dimmed copy of the icon this way (World.coolDownAct);
    // refusing it left the overlay as a GPU-only bitmap Pixi could not show.
    const ct = colorTransform ? readColorTransform(colorTransform) : null;
    if (colorTransform && !ct) { stats.pixiBitmapDrawLastSkip = "color-transform"; return false; }
    if (!record.outer.visible || source.mask || source.filters?.length ||
        (blendMode && blendMode !== "normal" && blendMode !== "layer") ||
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
      if (ct) applyColorTransform(data, ct);
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
