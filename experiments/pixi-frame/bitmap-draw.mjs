import { Matrix, RenderTexture, ColorMatrixFilter } from "pixi.js";

// Flash ColorTransform (multipliers and 0..255 offsets) from an AwayFL or AS3
// object; null when it cannot be read.
function readColorTransform(t) {
  const keys = ["redMultiplier", "greenMultiplier", "blueMultiplier", "alphaMultiplier",
    "redOffset", "greenOffset", "blueOffset", "alphaOffset"];
  // Accessors first (AwayJS and AS3 objects); the raw array's layout varies.
  for (const source of [t, t.adaptee]) {
    if (!source) continue;
    const v = keys.map(k => source[k] ?? source["$Bg" + k]);
    if (v.every(Number.isFinite)) return v;
  }
  const raw = t._rawData || t.adaptee?._rawData;
  const v = raw?.length >= 8 ? Array.from(raw).slice(0, 8) : null;
  return v?.every(Number.isFinite) ? v : null;
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
export function createBitmapDraw(renderer, records, stats, { prepare = null, scale = () => 1, onHiRes = null } = {}) {
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
  // Flash's BitmapData.draw ignores the source's own visibility: the game's
  // part rasterizer (Game.rasterizePart) hides each part and then draws it
  // into a bitmap that replaces it. Declining hidden sources sent those draws
  // to AwayFL's stage-resolution path, so parts turned pixelated a moment
  // after the sharp first frame. Show the root only for this draw.
  return function draw(bitmap, source, ...rest) {
    const hiddenRoot = source?.visible === false;
    if (!hiddenRoot) return drawVisible(bitmap, source, ...rest);
    source.visible = true;
    try {
      const ok = drawVisible(bitmap, source, ...rest);
      if (ok) stats.pixiBitmapDrawHiddenRoots = (stats.pixiBitmapDrawHiddenRoots || 0) + 1;
      return ok;
    } finally { source.visible = false; }
  };
  function drawVisible(bitmap, source, matrix, colorTransform, blendMode, clipRect) {
    let record = records.get(source);
    let treeReason = preparedTree(source, source);
    // A branch the game snapshots right after changing it (the room map is
    // moved into place, then drawn) is prepared on demand instead of
    // declining the draw to AwayFL's low-resolution GPU path.
    if (treeReason && prepare) {
      prepare(source);
      record = records.get(source);
      treeReason = preparedTree(source, source);
      if (!treeReason) stats.pixiBitmapDrawPrepared = (stats.pixiBitmapDrawPrepared || 0) + 1;
    }
    if (treeReason) { stats.pixiBitmapDrawLastSkip = treeReason; return false; }
    // A colour transform is applied to the read-back pixels below. Skill
    // cooldowns draw a dimmed copy of the icon this way (World.coolDownAct);
    // refusing it left the overlay as a GPU-only bitmap Pixi could not show.
    let ct = colorTransform ? readColorTransform(colorTransform) : null;
    const unreadable = colorTransform && !ct;
    if (ct && ct.every((v, i) => v === (i < 4 ? 1 : 0))) ct = null;
    if (unreadable) {
      stats.pixiBitmapDrawLastSkip = "color-transform";
      const proto = Object.getPrototypeOf(colorTransform);
      stats.pixiBitmapDrawColorShape = { own: Object.keys(colorTransform).slice(0, 16), proto: proto ? Object.getOwnPropertyNames(proto).slice(0, 24) : null,
        ctor: colorTransform.constructor?.name, adaptee: colorTransform.adaptee ? Object.keys(colorTransform.adaptee).slice(0, 12) : null,
        raw: colorTransform._rawData ? Array.from(colorTransform._rawData).map(String) : null,
        getters: ["redMultiplier", "alphaMultiplier", "redOffset"].map(k => String(colorTransform[k])) };
      return false;
    }
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
      // Flash shows this bitmap stretched to the screen (the room snapshot is
      // stage-sized, 960 wide, on a 4K display). Keep a copy rendered at the
      // display's pixel density for Pixi to show while the game leaves the
      // bitmap unchanged; the game itself keeps its stage-sized pixels.
      // A colour transform is applied with a colour-matrix filter: before,
      // such draws kept bitmap resolution, and a tinted snapshot layer showed
      // pixelated on top of the sharp room.
      // 1.5x the display density, capped at 4x: render-texture MSAA depends on
      // the driver (edges came out aliased on a laptop GPU), and the
      // downscale on display smooths them regardless.
      const k = Math.min(4, Math.max(1, Math.ceil(scale() * 1.5 - 0.05)));
      stats.pixiBitmapHiResScale = k;
      if (onHiRes && k > 1 && bitmap.width * k <= 8192 && bitmap.height * k <= 8192) {
        const hi = RenderTexture.create({ width: bitmap.width, height: bitmap.height, resolution: k, antialias: true,
          scaleMode: "linear", autoGenerateMipmaps: false });
        const outer = record.outer, previous = outer.filters;
        let colorFilter = null;
        if (ct) {
          const [rm, gm, bm, am, ro, go, bo, ao] = ct;
          colorFilter = new ColorMatrixFilter();
          colorFilter.matrix = [rm, 0, 0, 0, ro / 255, 0, gm, 0, 0, go / 255, 0, 0, bm, 0, bo / 255, 0, 0, 0, am, ao / 255];
          colorFilter.resolution = k;
          outer.filters = previous?.length ? [...previous, colorFilter] : [colorFilter];
        }
        try {
          renderer.render({ container: outer, target: hi,
            transform: new Matrix(...values), clear: true, clearColor: [0, 0, 0, 0] });
        } finally {
          if (colorFilter) { outer.filters = previous; colorFilter.destroy(); }
        }
        onHiRes(bitmap, hi);
        stats.pixiBitmapHiRes = (stats.pixiBitmapHiRes || 0) + 1;
      }
      return true;
    } catch (error) {
      stats.pixiBitmapDrawLastError = String(error);
      return false;
    } finally {
      target.destroy(true);
    }
  };
}
