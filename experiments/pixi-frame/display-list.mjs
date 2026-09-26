import { WebGLRenderer, Container, Matrix, Mesh, Texture, BufferImageSource, Sprite, Shader, GlProgram, UniformGroup, Graphics, AlphaFilter, Rectangle } from "pixi.js";
import { FlashHardLightBlend } from "./flash-blends.mjs";
import {
  OverlayBlend,
  DarkenBlend,
  LightenBlend,
  DifferenceBlend,
} from "pixi.js";
const advancedBlends = {
  overlay: OverlayBlend,
  "hard-light": FlashHardLightBlend,
  darken: DarkenBlend,
  lighten: LightenBlend,
  difference: DifferenceBlend,
};
import { installVectorBatcher } from "./vector-batcher.mjs";
import { installBlendResolve } from "./blend-resolve.mjs";
import { createEffectTextureCache } from "./effect-texture-cache.mjs";
import { createRenderProfiler } from "./render-profile.mjs";
import { installIdleHover } from "./idle-hover.mjs";
import { installCatchUp } from "./catch-up.mjs";
import { createSceneryCache } from "./scenery-cache.mjs";
import { RetainedEffects } from "./display-list-effect-cache.mjs";
import { createGeometryCache } from "./display-list-geometry.mjs";
import { createNativePaths } from "./native-paths.mjs";
import { createNativePicking } from "./native-picking.mjs";
import { describeNativeText, syncNativeText, retireNativeText } from "./native-text.mjs";
import { retirePixiTexture } from "./retire-pixi-texture.mjs";
import { constantTextureOffset, createTextureSamples } from "./texture-samples.mjs";
import { createDirectObjectBindings } from "./direct-object-bindings.mjs";
import { createBitmapDraw } from "./bitmap-draw.mjs";
import {
  describeFilter,
  createFilter,
  filterProgramKey,
  updateFilter,
  destroyFilter,
} from "./display-list-filters.mjs";
import { createAssetTracker, combineColor, screenSpaceStroke } from "./display-list-data.mjs";
import { installPixiPickBounds } from "./pixi-pick-bounds.mjs";
import { installPixiPickEvents } from "./pixi-pick-events.mjs";

const IDENTITY_COLOR = new Float32Array([1, 1, 1, 1, 0, 0, 0, 0]);
const vertex = `
precision highp float;
attribute vec2 aPosition;
attribute vec2 aUV;
attribute vec3 aCurve;
uniform mat3 uProjectionMatrix, uWorldTransformMatrix, uTransformMatrix;
varying vec2 vUV;
varying vec3 vCurve;
void main() {
  vec3 p = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vUV = aUV;
  vCurve = aCurve;
}`;
const fragment = `
precision highp float;
varying vec2 vUV;
varying vec3 vCurve;
uniform sampler2D uTexture;
uniform vec4 uMultiply, uOffset, uRect;
uniform float uRadial;
void main() {
  if ((vCurve.y * vCurve.y - vCurve.z) * vCurve.x < 0.0) discard;
  vec2 uv = uRadial > 0.5 ? vec2(clamp(length(vUV), 0.0, 1.0), 0.0) * uRect.xy + uRect.zw : vUV;
  vec4 c = texture2D(uTexture, uv);
  vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  c = clamp(vec4(rgb, c.a) * uMultiply + uOffset, 0.0, 1.0);
  gl_FragColor = vec4(c.rgb * c.a, c.a);
}`;
const same = (a, b) => a?.length === b.length && b.every((v, i) => v === a[i]);
const SUMMARY_COUNTERS = ["nodes", "meshes", "batchedMeshes", "customMeshes", "vectorBatchedMeshes", "nativeGraphics", "nativeGradients", "nativeBitmaps", "nativeCompounds", "nativeTexts", "directBlendGroups", "isolatedBlendGroups", "batchGroups"];
const clamp = (v) => Math.max(0, Math.min(1, v));

// Experimental backend: walks display objects, never invokes AwayFL's root
// renderer. Own canvas/context/textures; no render-command capture or GPU readback.
export async function startDisplayList(
  player,
  { onStatus = () => {}, cacheEffects = true, directObjects = false, cacheScenery = true, vectorBatching = true, boundedBlends = true, partialUploads = true, renderGroups = true, groupVertexLimit = 6000, reuseFilters = true, isolateTopology = true, sparseUploads = true, skipUnchanged = true, idleHoverHz = 0, retainedHover = true, pixiPickBounds = false, pixiEvents = false, catchUp = false, reuseTranslations = true, retainContent = true, retainMaskedContent = true, skipUnchangedColors = true, nativeGraphics = false, shapeSprites = false, nativeText, nativeBatching = true, sampledTextures = true, pixiBitmapDraw = false, retainPaths = 4096, retainGeometry = 4096, pixiEventsScopedPress = true, pixiEventsCull = false, effectTextures = false, directMultiBlend = true, antialias = true, bezierSmoothness, reuseLinear = true, arrivalBudgetMs = 12, arrivalMaxFrames = 8, arrivalFreezeMs = 60, arrivalHide = false, instancedTransforms = true, isolateNeighbors = 12000, maskGroups = false } = {},
) {
  const useNativeText = nativeText ?? nativeGraphics;
  const native = player._renderer;
  const original = native.render;
  const sourceCanvas = player._view.stage.context._gl.canvas;
  const pathSource = nativeGraphics ? sourceCanvas.ownerDocument.defaultView.__PIXI_FLASH_PATHS__ : null;
  if (nativeGraphics && typeof pathSource?.get !== "function") throw Error("Native graphics requires the experimental path runtime; reload with nativeGraphics=1");
  // Pixi's federated event mixin is an opt-in module in v8.
  if (directObjects && pixiEvents) await import("pixi.js/events");
  const canvas = sourceCanvas.ownerDocument.createElement("canvas");
  canvas.dataset.pixiDisplayList = "";
  canvas.style.cssText = "position:fixed;pointer-events:none;z-index:1;";
  const renderer = new WebGLRenderer();
  const paused = player.isPaused;
  let restoreVectorBatcher, instanced = false;
  player.isPaused = true;
  try {
    await renderer.init({
      canvas,
      width: sourceCanvas.width,
      height: sourceCanvas.height,
      resolution: 1,
      antialias,
      bezierSmoothness,
      background: 0,
      backgroundAlpha: 1,
      useBackBuffer: true,
    });
    renderer.events?.setTargetElement(null);
    if (vectorBatching) restoreVectorBatcher = installVectorBatcher(renderer, partialUploads, sparseUploads, skipUnchanged, nativeGraphics && nativeBatching, instancedTransforms);
    instanced = !!restoreVectorBatcher?.instanced;
  } catch (error) {
    renderer.destroy();
    throw error;
  } finally {
    player.isPaused = paused;
  }
  sourceCanvas.ownerDocument.body.append(canvas);
  const scene = new Container();
  const groupOwners = new WeakMap();
  // Flash objects whose hit test is an invisible hit state (button hit
  // areas, walkable regions). Pixi cannot see them, so scoped picks must
  // always admit their branches.
  const hitStateNodes = new Set();
  const records = new Map(),
    textures = new Map();
  const observedHTMLTextures = new WeakSet();
  const tracker = createAssetTracker((r) => sourceChanged(r));
  const textureSamples = createTextureSamples(tracker);
  const detachedRecords = new Map();
  const stats = {
    active: true,
    mode: directObjects ? "direct-objects" : "display-list",
    configuration: { nativeGraphics, retainPaths, retainGeometry, isolateNeighbors, arrivalBudgetMs, arrivalMaxFrames, arrivalFreezeMs, arrivalHide, instancedTransforms: instanced, effectTextures: directObjects && effectTextures, directMultiBlend, antialias, bezierSmoothness: bezierSmoothness ?? null, shapeSprites: nativeGraphics && shapeSprites, nativeText: useNativeText, nativeBatching, sampledTextures, cacheScenery: directObjects && cacheScenery, groupVertexLimit,
      retainContent, retainMaskedContent, skipUnchangedColors, reuseTranslations, retainedHover: directObjects && retainedHover, pixiPickBounds: false, pixiEvents: false },
    deferredGeometry: pathSource?.lazyStats ?? null,
    pixiBitmapDraws: 0,
    batchGroups: 0,
    directTransformUpdates: 0,
    translationReuses: 0,
    localMaskUpdates: 0,
    unchangedColorUpdates: 0,
    directHierarchyUpdates: 0,
    polledTransforms: 0,
    preparedNodes: 0,
    preparedContents: 0,
    retainedContents: 0,
    skippedSubtrees: 0,
    preparationPasses: 0,
    reusedPreparations: 0,
    frames: 0,
    fps: 0,
    idleHoverHz: 0,
    retainedHover: false,
    hoverChecks: 0,
    hoverSkips: 0,
    syncMs: 0,
    pixiMs: 0,
    nodes: 0,
    meshes: 0,
    batchedMeshes: 0,
    customMeshes: 0,
    vectorBatchedMeshes: 0,
    directBlendGroups: 0,
    isolatedBlendGroups: 0,
    geometryBuilds: 0,
    textureUploads: 0,
    nativeTexts: 0,
    uniformUpdates: 0,
    effectCacheHits: 0,
    directMultiBlendGroups: 0,
    linearReuses: 0,
    effectCacheBuilds: 0,
    effectCachePixels: 0,
    effectPasses: 0,
    drawnFrames: 0,
    reusedFrames: 0,
    renderSize: [0, 0],
    unsupported: {},
    lastError: null,
  };
  const restoreBlendResolve = boundedBlends ? installBlendResolve(renderer, stats) : null;
  const profiler = createRenderProfiler(renderer, stats, root => {
    const node = groupOwners.get(root);
    const path = [];
    for (let n = node; n && path.length < 12; n = n.parent)
      path.unshift(n.name || `${n.assetType || "object"}#${n.id}`);
    return { path: path.join("/"), kind: node ? (records.get(node)?.outer === root ? "object" : "cache") : "stage" };
  }, player);
  const restoreIdleHover = installIdleHover(player, stats, idleHoverHz,
    undefined, directObjects && retainedHover ? () => stats.drawnFrames : null);
  const restoreCatchUp = directObjects && catchUp ? installCatchUp(player, stats) : null;
  const restorePixiPickEvents = directObjects && pixiEvents
    ? installPixiPickEvents(player, scene, records, groupOwners, renderer, stats, { nativePress: !pixiEventsScopedPress, hitStates: () => hitStateNodes, cull: pixiEventsCull }) : null;
  const restorePixiPickBounds = directObjects && pixiPickBounds && !pixiEvents
    ? installPixiPickBounds(player, records, stats, renderer) : null;
  const scenery = directObjects && cacheScenery
    ? createSceneryCache(stats, () => { visualDirty = true; }) : null;
  const effectTextureCache = directObjects && cacheEffects && effectTextures
    ? createEffectTextureCache(stats, () => { visualDirty = true; }) : null;
  const geometryCache = createGeometryCache(tracker, stats, { retain: retainGeometry });
  const nativePaths = createNativePaths(stats, renderer, { shapeSprites: nativeGraphics && shapeSprites, retain: retainPaths });
  const nativePicking = createNativePicking(pathSource?.Box);
  let revision = 0;
  // Arrival gating: a branch attached under an existing parent (a player's
  // gear SWFs, a new room) is prepared under a per-frame time budget and
  // stays hidden until every shape in it has a mesh, then appears whole.
  // Five SWFs landing together used to convert in one frame: three tasks
  // of about 200 ms each in a busy room.
  let arrivalSpent = 0, arrivalRoot = null, arrivalFreeze = false;
  stats.arrivalDeferred = 0; stats.arrivalHidden = 0; stats.arrivalRoots = 0; stats.arrivalFrozen = 0;
  stats.filterAreaUpdates = 0;
  function nothingDrawsBeneath(node) {
    for (let n = node; n?.parent; n = n.parent) {
      const siblings = n.parent._children || [];
      for (let i = 0, end = siblings.indexOf(n); i < end; i++) {
        const sibling = siblings[i];
        if (sibling.visible !== false && records.get(sibling)?.drawCost > 0) return false;
      }
    }
    return true;
  }
  function dirty(r, reason = "appearance") {
    visualDirty = true;
    if (r) { r.revision = ++revision; r.lastChange = reason; }
  }
  let needsSweep = false;
  let visualDirty = true,
    previousProjection,
    previousBuilds = -1,
    previousUploads = -1;
  const bindings = directObjects ? createDirectObjectBindings({
    record: nodeRecord,
    update: updateObject,
    changed: sourceChanged,
    linearChanged: reuseLinear ? linearChanged : null,
    hierarchyChanged: (r) => { if (r) dirty(r, "hierarchy"); },
    detached: (r) => detachedRecords.set(r, stats.frames),
    stats,
    profiler,
    reuseTranslations,
    retainMaskedContent,
    skipUnchangedColors,
  }) : null;
  let failed = false, pauseBeforeFailure;
  let stopped = false,
    statusTime = performance.now(),
    statusFrames = 0;
  let program;
  const missing = (reason) => {
    stats.unsupported[reason] = (stats.unsupported[reason] || 0) + 1;
  };
  function linearChanged(r) {
    if (!r) return;
    r.linearDirty = true;
    for (let node = r.node; node; node = node.parent) {
      const parent = records.get(node);
      if (!parent || parent.branchDirty) break;
      parent.branchDirty = true;
    }
  }
  function sourceChanged(r, descendants = false, content = true) {
    if (!r) return;
    r.selfDirty ||= content;
    r.descendantsDirty ||= descendants;
    // Invalidation requests a comparison, not necessarily a new picture.
    // Actual transform/paint/filter changes below advance visual revisions.
    for (let node = r.node; node; node = node.parent) {
      const parent = records.get(node);
      if (!parent || parent.branchDirty) break;
      parent.branchDirty = true;
    }
  }
  function summaryStart() {
    return { counts: SUMMARY_COUNTERS.map((k) => stats[k]), unsupported: { ...stats.unsupported } };
  }
  function finishSummary(r, before) {
    r.summary = {
      counts: SUMMARY_COUNTERS.map((k, i) => stats[k] - before.counts[i]),
      unsupported: Object.fromEntries(Object.entries(stats.unsupported)
        .map(([k, v]) => [k, v - (before.unsupported[k] || 0)]).filter(([, v]) => v)),
    };
  }
  function reuseSummary(r) {
    SUMMARY_COUNTERS.forEach((k, i) => stats[k] += r.summary.counts[i]);
    for (const [k, v] of Object.entries(r.summary.unsupported))
      stats.unsupported[k] = (stats.unsupported[k] || 0) + v;
  }
  function retireDetached() {
    function attached(node) {
      for (; node; node = node.parent) if (node === player.root) return true;
      return false;
    }
    function retire(node) {
      for (const child of node._children || []) retire(child);
      const r = records.get(node);
      if (!r) return;
      destroyRecord(r);
      records.delete(node);
      detachedRecords.delete(r);
    }
    for (const [r, frame] of detachedRecords) {
      if (attached(r.node)) detachedRecords.delete(r);
      else if (frame < stats.frames - 2) retire(r.node);
    }
  }
  function imageTexture(image, sampler, sampleOffset = null) {
    if (!image || image.isDisposed || image.width <= 0 || image.height <= 0)
      return null;
    // BitmapData.draw still belongs to the Flash runtime. Never silently read
    // its GPU-only result back to the CPU (or upload a stale CPU copy).
    const version = tracker.version(image, "invalidateGPU", bindings ? "_imageDataDirty" : null, sampleOffset === null);
    if (image._imageDataDirty) {
      missing("gpu-bitmap");
      return null;
    }
    // Keep native upload flags untouched; edits may coalesce until AwayFL
    // next uploads this bitmap, even though Pixi owns a separate texture.
    let r = textures.get(image);
    const key = `${!!sampler?.repeat}:${sampler?.smooth !== false}`;
    if (!r) {
      r = { variants: new Map() };
      textures.set(image, r);
    }
    r.epoch = stats.frames;
    if (r.version !== version || r.sourceData !== image._data) {
      const data = image.getDataInternal?.(true, false);
      if (!data) {
        missing("bitmap-source");
        return null;
      }
      r.sourceData = data;
      r.data = data;
      r.version = tracker.version(image, undefined, undefined, sampleOffset === null);
      if (image.unpackPMA) {
        r.data = new Uint8Array(data.length);
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i + 3];
          r.data[i] = Math.round((data[i] * a) / 255);
          r.data[i + 1] = Math.round((data[i + 1] * a) / 255);
          r.data[i + 2] = Math.round((data[i + 2] * a) / 255);
          r.data[i + 3] = a;
        }
      }
      // Typed-array uploads ignore WebGL's unpack-premultiply switch. Convert
      // straight RGBA once per revision without changing AwayFL's CPU data.
      for (const t of r.variants.values()) {
        t.source.resource = r.data;
        t.source.alphaMode = "premultiplied-alpha";
        t.source.resize(image.width, image.height);
        t.source.update();
        stats.textureUploads++;
      }
    }
    let t = r.variants.get(key);
    if (!t) {
      t = new Texture({
        source: new BufferImageSource({
          resource: r.data,
          width: image.width,
          height: image.height,
          format: "rgba8unorm",
          alphaMode: "premultiplied-alpha",
          addressMode: sampler?.repeat ? "repeat" : "clamp-to-edge",
          scaleMode: sampler?.smooth === false ? "nearest" : "linear",
        }),
      });
      r.variants.set(key, t);
      stats.textureUploads++;
    }
    return t;
  }
  function disposeMesh(r) {
    dirty(r.owner);
    if (r.pickingElements) nativePicking.release(r.pickingElements, r.pathEntry.context);
    r.mesh.removeFromParent();
    r.mesh.destroy();
    if (r.pathEntry) nativePaths.release(r.pathEntry);
    r.shader?.destroy();
    geometryCache.release(r.geometryEntry);
  }
  function shapeMesh(shape, node, record, index, color) {
    if (!arrivalRoot || record.meshes[index]) return shapeMeshInner(shape, node, record, index, color);
    // The floor is per branch, so an ordinary timeline child (a few shapes)
    // always completes in its frame; the frame cap bounds several branches
    // arriving together.
    if (arrivalRoot.arrivalSpent >= arrivalRoot.arrivalBudget || arrivalSpent >= arrivalBudgetMs * 4) {
      arrivalRoot.arrivalIncomplete = true;
      arrivalRoot.arrivalDeferredCount++;
      stats.arrivalDeferred++;
      sourceChanged(record, false, true);
      return null;
    }
    const started = performance.now();
    try { return shapeMeshInner(shape, node, record, index, color); }
    finally {
      const spent = performance.now() - started;
      arrivalSpent += spent;
      arrivalRoot.arrivalSpent += spent;
      arrivalRoot.arrivalPreparedMs += spent;
      arrivalRoot.arrivalPreparedCount++;
    }
  }
  function shapeMeshInner(shape, node, record, index, color) {
    const e = shape.elements;
    const path = pathSource?.get(shape);
    // Text uses atlas/glyph meshes. Skinning and nine-slice geometry may already
    // have been deformed by Flash; retain their mesh representation.
    const bitmapImage = path?.bitmap?.image;
    const bitmapTexture = bitmapImage && imageTexture(bitmapImage,
      { repeat: true, smooth: path.bitmap.smooth });
    if (path && nativePaths.supports(path) && (!bitmapImage || (bitmapTexture &&
        bitmapImage.width === path.bitmap.width && bitmapImage.height === path.bitmap.height)) &&
        !node.animator && !shape.particleCollection && !e?.scale9Grid &&
        ((!path.gradient && !path.bitmap) || color.slice(4).every(v => v === 0)) &&
        typeof node.text !== "string") {
      tracker.version(e);
      tracker.version(e.positions?.attributesBuffer);
      if (path.stroke) tracker.version(e.thickness?.attributesBuffer);
      let r = record.meshes[index];
      if (r?.pathEntry?.path !== path) {
        if (r) disposeMesh(r);
        const { entry, graphics } = nativePaths.acquire(path, bitmapTexture);
        r = record.meshes[index] = { shape, mesh: graphics, pathEntry: entry, owner: record };
        // Pixi handles the path test only when one contour maps unambiguously
        // to the same AwayFL element. Compound fills retain native picking.
        if (path.contours === 1 && nativePicking.bind(e, entry.context))
          r.pickingElements = e;
        dirty(record, "paint");
      }
      const baseColor = path.gradient || path.bitmap ? 0xffffff : path.color;
      const rgb = [(baseColor >> 16) & 255, (baseColor >> 8) & 255, baseColor & 255]
        .map((v, i) => Math.round(clamp(v / 255 * color[i] + color[i + 4] / 255) * 255));
      const tint = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
      const alpha = clamp((path.alpha ?? 1) * color[3] + color[7] / 255);
      if (r.mesh.tint !== tint || r.mesh.alpha !== alpha) dirty(record, "paint");
      r.mesh.tint = tint; r.mesh.alpha = alpha; r.mesh.visible = true;
      stats.nativeGraphics++;
      if (path.gradient) stats.nativeGradients++;
      if (path.bitmap) stats.nativeBitmaps++;
      if (path.contours > 1 && !path.stroke) stats.nativeCompounds++;
      return r.mesh;
    }
    if (record.meshes[index]?.pathEntry) {
      disposeMesh(record.meshes[index]); record.meshes[index] = null;
    }
    // Report why an authored path stays on the mesh route: each reason is a
    // candidate for the native renderer, and a deferred shape pays a full
    // tessellation here.
    if (path) {
      missing("native-fallback:" + (!nativePaths.supports(path) ? "contours"
        : bitmapImage && !(bitmapTexture && bitmapImage.width === path.bitmap.width &&
            bitmapImage.height === path.bitmap.height) ? "bitmap-size"
        : node.animator || shape.particleCollection ? "animator"
        : e?.scale9Grid ? "scale9"
        : (path.gradient || path.bitmap) && !color.slice(4).every(v => v === 0) ? "paint-offset"
        : typeof node.text === "string" ? "text" : "other"));
    } else if (pathSource?.deferred?.(shape)) missing("native-fallback:no-snapshot");
    // A native path can temporarily require the compatibility mesh (for
    // example, after a color offset or texture change). Build its real Flash
    // triangles before the mesh adapter reads the deferred buffer.
    pathSource?.ensureGeometry(shape);
    if (
      !e ||
      !["[asset TriangleElements]", "[asset LineElements]"].includes(
        e.assetType,
      )
    ) {
      missing("geometry:" + (e?.assetType || shape.assetType));
      return null;
    }
    if (node.animator || shape.particleCollection) missing("animator");
    if (e.assetType === "[asset LineElements]" && ![1, 2, 4].includes(e.scaleMode))
      missing("stroke-scale-mode:" + e.scaleMode);
    // Screen-space extrusion depends on the world transform; the owner must be
    // re-prepared when an ancestor rotates or scales.
    if (e.assetType === "[asset LineElements]" && screenSpaceStroke(e)) record.screenStrokes = true;
    const material = shape.material || node.material;
    const style = shape.style || node.style;
    const tex = material?.getTextureAt?.(0);
    const image =
      tex &&
      (style?.getImageAt?.(tex) ||
        node.style?.getImageAt?.(tex) ||
        material?.style?.getImageAt?.(tex) ||
        tex?.getImageAt?.(0));
    const sampler =
      tex &&
      (style?.getSamplerAt?.(tex) ||
        node.style?.getSamplerAt?.(tex) ||
        material?.style?.getSamplerAt?.(tex) ||
        tex?.getSamplerAt?.(0));
    // originalFillStyle survives Shape pooling and may describe a previous
    // object (notably text constructed after graphics are retired). The active
    // material, image and UV mapping are the authoritative paint source.
    const uv =
      style?.uvMatrix || node.style?.uvMatrix || material?.style?.uvMatrix;
    const curves = e.getCustomAtributes?.("curves");
    const radial = tex?.mappingMode === 1;
    const sampleOffset = bindings && sampledTextures ? constantTextureOffset(image, uv, radial) : null;
    // Register before uploading: even a GPU-only/disposed image must wake the
    // owner when it becomes CPU-readable again.
    const imageRevision = image && sampleOffset !== null
      ? textureSamples.version(image, sampleOffset) : null;
    const texture = tex ? imageTexture(image, sampler, sampleOffset) : Texture.WHITE;
    if (!texture) return null;
    let custom =
      !!curves ||
      radial ||
      color.some((c, i) => (i < 4 ? c < 0 || c > 1 : c !== 0));
    let r = record.meshes[index];
    // Sticky: once a mesh needed the Flash batcher (a colour transform, a
    // hit flash), keep it there. Flipping back disposed and recreated the
    // mesh in the other batcher, a structural change that rebuilt its whole
    // render group at the start and end of every flash and fade.
    if (r?.custom && !custom && vectorBatching) custom = true;
    if (r && r.custom !== custom) {
      disposeMesh(r);
      r = null;
    }
    const geometryEntry = geometryCache.sync(
      r?.geometryEntry,
      shape,
      uv,
      custom || !!curves,
      record.world,
    );
    const geometry = geometryEntry.geometry;
    // Entries can mutate the same geometry in place. Retain primitive counts,
    // not the previous geometry reference, to detect a batch layout change.
    const vertexCount = geometry.positions.length / 2;
    const indexCount = geometry.indices.length;
    if (r && (r.vertexCount !== vertexCount || r.indexCount !== indexCount))
      record.changingTopology = true;
    if (!custom || vectorBatching) geometry.batchMode = "batch";
    if (!r) {
      const mesh = new Mesh({ geometry, texture });
      // Ordinary geometry can share Pixi's default batch with native Graphics.
      // Reserve the wider Flash vertex format for curves/radial fills/offsets.
      // Instanced transforms apply to the Flash vector meshes only: routing
      // every plain mesh and Graphics shape into the 92-byte format
      // quadrupled rebuild repacks in combat (t9.json). In combat those
      // vector meshes repacked about 140 times a frame only for moving.
      mesh.flashVectorBatch = vectorBatching && (custom || !nativeGraphics || !nativeBatching);
      r = record.meshes[index] = {
        shape,
        mesh,
        geometryEntry,
        custom,
        owner: record,
      };
      if (custom && !vectorBatching) {
        program ||= GlProgram.from({
          vertex,
          fragment,
          name: "flash-display-list",
        });
        r.uniforms = new UniformGroup({
          uMultiply: { value: new Float32Array(4), type: "vec4<f32>" },
          uOffset: { value: new Float32Array(4), type: "vec4<f32>" },
          uRect: { value: new Float32Array([1, 1, 0, 0]), type: "vec4<f32>" },
          uRadial: { value: 0, type: "f32" },
        });
        r.shader = new Shader({
          glProgram: program,
          resources: { uTexture: texture.source, flash: r.uniforms },
        });
        mesh.shader = r.shader;
      }
    }
    const paintKey = [
      geometry,
      geometryEntry.revision,
      texture,
      image ? (imageRevision ?? tracker.version(image)) : 0,
      radial,
      sampler?.imageRect?.width,
      sampler?.imageRect?.height,
      sampler?.imageRect?.x,
      sampler?.imageRect?.y,
      material?.style?.color,
      material?.ambientMethod?.alpha,
    ];
    const paintChanged = !same(r.paintKey, paintKey);
    if (paintChanged) {
      dirty(record, "paint");
      r.paintKey = paintKey;
    }
    r.shape = shape;
    r.vertexCount = vertexCount;
    r.indexCount = indexCount;
    r.geometryEntry = geometryEntry;
    r.mesh.geometry = geometry;
    const mesh = r.mesh;
    mesh.texture = texture;
    mesh.visible = true;
    if (mesh.flashVectorBatch) {
      mesh.flashRect = custom ? sampler?.imageRect : null;
      if (paintChanged) mesh.onViewUpdate();
    }
    if (custom) {
      if (paintChanged || record.colorChanged) {
        if (vectorBatching) {
          mesh.flashMultiply = color.slice(0, 4);
          mesh.flashOffset = Float32Array.from(color.subarray(4), v => v / 255);
          mesh.flashRadial = +radial;
          mesh.onViewUpdate();
        } else {
          r.shader.resources.uTexture = texture.source;
          const u = r.uniforms.uniforms;
          u.uMultiply.set(color.subarray(0, 4));
          for (let i = 0; i < 4; i++) u.uOffset[i] = color[i + 4] / 255;
          u.uRadial = +radial;
          const rect = sampler?.imageRect;
          u.uRect.set(
            rect ? [rect.width, rect.height, rect.x, rect.y] : [1, 1, 0, 0],
          );
          r.uniforms.update();
        }
        stats.uniformUpdates++;
      }
      if (vectorBatching) stats.vectorBatchedMeshes++;
      else stats.customMeshes++;
    } else {
      if (paintChanged || record.colorChanged) {
        const base = !tex ? (material?.style?.color ?? 0xffffff) : 0xffffff;
        const alpha = !tex ? (material?.ambientMethod?.alpha ?? 1) : 1;
        const rgb = [(base >> 16) & 255, (base >> 8) & 255, base & 255].map(
          (c, i) =>
            Math.round(clamp((c / 255) * color[i] + color[i + 4] / 255) * 255),
        );
        mesh.tint = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
        mesh.alpha = clamp(alpha * color[3] + color[7] / 255);
      }
    }
    if (vectorBatching || !custom) stats.batchedMeshes++;
    stats.meshes++;
    return mesh;
  }
  function arrange(container, children, record) {
    for (let i = 0; i < children.length; i++) {
      if (container.children[i] !== children[i]) {
        dirty(record);
        container.addChildAt(children[i], i);
      }
    }
    while (container.children.length > children.length) {
      dirty(record);
      container.removeChildAt(children.length);
    }
  }
  function nodeRecord(node) {
    let r = records.get(node);
    if (!r) {
      r = {
        node,
        childLayer: directObjects ? new Container() : null,
        outer: new Container(),
        content: new Container(),
        meshes: [],
        color: new Float32Array(8),
        matrix: new Matrix(),
        wrappers: [],
        filterKey: null,
        filters: [],
        revision: ++revision,
      };
      r.outer.addChild(r.content);
      if (r.childLayer) r.content.addChild(r.childLayer);
      if (pixiEvents && directObjects) r.outer.eventMode = "passive";
      records.set(node, r);
      groupOwners.set(r.outer, node);
      groupOwners.set(r.content, node);
    }
    return r;
  }
  function updateObject(node, r) {
    if (pixiEvents && directObjects) {
      // Flash routes hits on mouse-disabled art and on mouseChildren=false
      // subtrees to an ancestor. Keep every branch hittable so Pixi still
      // reports the topmost art; the scoped native pick applies those rules.
      r.outer.interactiveChildren = true;
      // An input field is hit over its whole box, not only its glyphs, so give
      // the container an explicit hit rectangle; otherwise a click on empty
      // space inside it resolves to whatever lies behind it. Dynamic labels
      // keep glyph hits only.
      if (typeof node.text === "string" && node.type === "input" && node._width > 0 && node._height > 0) {
        const x = node.textOffsetX || 0, y = node.textOffsetY || 0;
        if (!r.outer.hitArea) r.outer.hitArea = new Rectangle(x, y, node._width, node._height);
        else { r.outer.hitArea.x = x; r.outer.hitArea.y = y; r.outer.hitArea.width = node._width; r.outer.hitArea.height = node._height; }
        r.outer.eventMode = "static";
      } else {
        if (r.outer.hitArea) r.outer.hitArea = null;
        r.outer.eventMode = "passive";
      }
    }
    // A mask keeps clipping while hidden (AwayFL's TextField hides the mask
    // child it draws over overflowing glyphs); Pixi only fills the stencil
    // from a visible mask container, and never draws a mask on its own.
    const visible = node.visible !== false || node.maskMode === true;
    if (r.outer.visible !== visible) dirty(r);
    r.outer.visible = visible;
    const m = node.transform.matrix3D;
    const local = node._registrationMatrix3D ? m.clone() : m;
    if (node._registrationMatrix3D) {
      local.prepend(node._registrationMatrix3D);
      if (node.alignmentMode !== 0) {
        const q = node._registrationMatrix3D._rawData,
          s = node.transform.scale;
        local.appendTranslation(-q[12] * s.x, -q[13] * s.y, -q[14] * s.z);
      }
    }
    const a = local._rawData;
    r.is3D = !!(a[2] || a[6] || a[3] || a[7]);
    const transform = [a[0], a[1], a[4], a[5], a[12], a[13]];
    if (!same(r.transform, transform)) {
      dirty(r, "transform");
      r.transformRevision = r.revision;
      r.matrix.set(...transform);
      r.outer.setFromMatrix(r.matrix);
      r.transform = transform;
      if (directObjects) stats.directTransformUpdates++;
    }
  }
  function visit(
    node,
    inherited,
    path = new Set(),
    parentMatrix = scene.localTransform,
    parentTransformRevision = 0,
    force = false,
    linear = false,
  ) {
    if (path.has(node)) {
      missing("cyclic-display-list");
      return null;
    }
    path.add(node);
    const r = bindings ? bindings.own(node) : nodeRecord(node);
    const firstVisit = r.arrivedFrame === undefined;
    if (firstVisit) r.arrivedFrame = stats.frames;
    r.epoch = stats.frames;
    let gateRoot = false;
    if (arrivalBudgetMs > 0 && bindings && !arrivalRoot) {
      if (r.arrivalGated) gateRoot = true;
      else if (firstVisit) {
        const parentRecord = node.parent && records.get(node.parent);
        if (parentRecord?.arrivedFrame !== undefined && parentRecord.arrivedFrame < stats.frames) gateRoot = true;
      }
      if (gateRoot) {
        // Spread the estimated remaining work over the frames left, so a
        // small branch appears next frame and a whole room takes at most
        // arrivalMaxFrames; the budget floor keeps a frame from stalling.
        const frames = r.arrivalFrames || 0;
        const remaining = (r.arrivalDeferredCount || 0) * (r.arrivalPerShapeMs || 0);
        r.arrivalBudget = frames >= arrivalMaxFrames ? Infinity
          : Math.max(arrivalBudgetMs, remaining / Math.max(1, arrivalMaxFrames - frames));
        r.arrivalDeferredCount = 0; r.arrivalPreparedMs = 0; r.arrivalPreparedCount = 0; r.arrivalSpent = 0;
        // Hiding a branch that nothing draws beneath (a room's background
        // layer, arriving as its own SWF) exposes the clear colour. Such a
        // branch holds the previous picture instead, whatever its size.
        if (firstVisit) r.arrivalBottom = nothingDrawsBeneath(node);
        arrivalRoot = r; r.arrivalIncomplete = false; stats.arrivalRoots++;
      }
    }
    // An ancestor rotated or scaled: only transform-sensitive content and
    // subtrees need another preparation; the rest follows the Pixi hierarchy.
    const linearForce = linear || !!r.linearDirty;
    r.linearDirty = false;
    const linearSensitive = linearForce && r.subtreeTransformSensitive !== false;
    if (bindings && r.summary && !force && !r.branchDirty && !linearSensitive) {
      if (gateRoot) arrivalRoot = null;
      stats.skippedSubtrees++;
      reuseSummary(r);
      path.delete(node);
      return r.outer;
    }
    const before = bindings ? summaryStart() : null;
    const prepareContent = !bindings || !retainContent || !r.ownContent || force || r.selfDirty || r.descendantsDirty ||
      (linearForce && r.transformSensitive !== false);
    const forceChildren = force || r.descendantsDirty;
    r.branchDirty = r.selfDirty = r.descendantsDirty = false;
    stats.preparedNodes++;
    const visible = node.visible !== false || node.maskMode === true;
    if (r.outer.visible !== visible) dirty(r);
    r.outer.visible = visible;
    stats.nodes++;
    if (!r.outer.visible) {
      if (gateRoot) arrivalRoot = null;
      hitStateNodes.delete(node);
      scenery?.release(r);
      effectTextureCache?.release(r);
      if (before) finishSummary(r, before);
      path.delete(node);
      return r.outer;
    }
    if (node.pickObject) hitStateNodes.add(node); else if (hitStateNodes.size) hitStateNodes.delete(node);
    stats.hitStateNodes = hitStateNodes.size;
    if (!bindings) { stats.polledTransforms++; updateObject(node, r); }
    const a = r.transform;
    if (r.is3D) missing("3d-transform");
    const world = r.world || (r.world = new Matrix());
    world.set(
      parentMatrix.a * a[0] + parentMatrix.c * a[1],
      parentMatrix.b * a[0] + parentMatrix.d * a[1],
      parentMatrix.a * a[2] + parentMatrix.c * a[3],
      parentMatrix.b * a[2] + parentMatrix.d * a[3],
      0, 0,
    );
    const transformRevision = Math.max(
      parentTransformRevision,
      r.transformRevision || 0,
    );
    combineColor(inherited, node.transform.colorTransform?._rawData, r.color);
    r.colorChanged = !same(r.previousColor, r.color);
    if (r.colorChanged) {
      dirty(r, "color");
      r.previousColor = r.color.slice();
    }
    let children, ownVertices;
    if (!prepareContent && !r.colorChanged) {
      // A descendant mutation does not change this object's own retained meshes.
      // Asset subscriptions remain attached until the content actually changes.
      children = r.ownContent.children.slice();
      ownVertices = r.ownContent.vertices;
      reuseSummary(r.ownContent);
      stats.retainedContents++;
    } else {
      stats.preparedContents++;
      r.screenStrokes = false;
      const contentBefore = bindings ? summaryStart() : null;
      // Native getters/traversers can tessellate dirty graphics or lay out text.
      // Keep that cost separate from converting their output to Pixi objects.
      let entity;
      const endEntity = profiler.section("syncNativeMs");
      try { entity = node.getEntity?.(); }
      finally { endEntity?.(); }
      children = [];
      if (bindings) tracker.beginOwner(r);
      let shapeIndex = 0;
      const nativeTextSpec = useNativeText ? describeNativeText(node) : null;
      if (nativeTextSpec) {
        for (const old of r.meshes) if (old) disposeMesh(old);
        r.meshes.length = 0;
        children.push(syncNativeText(r, nativeTextSpec, r.color, world, dirty));
        const textCount = nativeTextSpec.lines?.filter(line => line.text).length || 1;
        stats.nativeTexts += textCount;
        stats.meshes += textCount;
      } else if (entity?.assetType === "[asset Billboard]") {
        retireNativeText(r);
        // Billboard geometry is generated on the CPU independently of render entities.
        const b = entity.billboardRect;
        const key = [entity.billboardWidth, entity.billboardHeight, b?.x, b?.y];
        if (!same(r.billboardKey, key)) {
          dirty(r);
          r.billboard?.destroy();
          r.billboard = new Sprite();
          r.billboardKey = key;
        }
        const texture = imageTexture(entity.image, entity.style?.sampler);
        if (texture) {
          if (r.billboard.texture !== texture) dirty(r);
          const imageRevision = tracker.version(entity.image);
          if (r.imageRevision !== imageRevision) dirty(r);
          r.imageRevision = imageRevision;
          r.billboard.texture = texture;
          r.billboard.position.set(-(b?.x || 0), -(b?.y || 0));
          r.billboard.width = key[0];
          r.billboard.height = key[1];
          r.billboard.alpha = clamp(r.color[3]);
          children.push(r.billboard);
          stats.meshes++;
          if (r.color.some((v, i) => (i === 3 ? false : v !== IDENTITY_COLOR[i])))
            missing("bitmap-color-transform");
        }
      } else {
        retireNativeText(r);
        const endNative = profiler.section("syncNativeMs");
        try {
          entity?._acceptTraverser?.({
            applyTraversable(shape) {
              const endShape = profiler.section("syncShapeMs");
              try {
                const mesh = shapeMesh(shape, node, r, shapeIndex++, r.color);
                if (mesh) children.push(mesh);
                else if (r.meshes[shapeIndex - 1]) {
                  disposeMesh(r.meshes[shapeIndex - 1]);
                  r.meshes[shapeIndex - 1] = null;
                }
              } finally { endShape?.(); }
            },
          });
        } finally { endNative?.(); }
      }
      if (r.shapeCount !== undefined && r.shapeCount !== shapeIndex)
        r.changingTopology = true;
      r.shapeCount = shapeIndex;
      while (r.meshes.length > shapeIndex) {
        const old = r.meshes.pop();
        if (old) disposeMesh(old);
      }
      if (bindings) tracker.endOwner();
      ownVertices = r.meshes.reduce((n, m) => n + (m?.mesh.geometry?.positions?.length || 0) / 2, 0);
      if (bindings) {
        r.ownContent = { children: children.slice(), vertices: ownVertices };
        finishSummary(r.ownContent, contentBefore);
      }
    }
    r.hasText = typeof node.text === "string";
    let cacheSafe = true, rasterSafe = true;
    let drawCost = children.length;
    let batchVertices = ownVertices;
    let drawingChildren = 0;
    let singleDraws = children.length;
    let childSensitive = false;
    const singleChildren = [];
    for (const child of node._children || []) {
      const object = visit(child, r.color, path, world, transformRevision, forceChildren, linearForce);
      if (object) {
        if (!bindings) children.push(object);
        const childRecord = records.get(child);
        if (childRecord.revision > r.revision) {
          r.revision = childRecord.revision;
          r.lastChange = childRecord.lastChange;
        }
        if (childRecord.outer.visible) {
          childSensitive ||= childRecord.subtreeTransformSensitive !== false;
          if (childRecord.drawCost) {
            drawingChildren++;
            if (childRecord.singleDraws === 1) singleChildren.push(childRecord);
          }
          singleDraws += childRecord.singleDraws ?? 2;
          drawCost += childRecord.drawCost || 0;
          // Existing child groups already own separate buffers.
          if (!childRecord.batchGroup) batchVertices += childRecord.batchVertices || 0;
          rasterSafe &&= childRecord.rasterSafe;
          r.hasText ||= childRecord.hasText;
        }
        if (childRecord.outer.visible && !childRecord.cacheSafe)
          cacheSafe = false;
      }
    }
    if (bindings) children.push(r.childLayer);
    arrange(r.content, children, r);
    if (directObjects && pixiEvents) for (const child of children) {
      if (child === r.childLayer) continue;
      child.eventMode = "static";
      groupOwners.set(child, node);
    }
    const scroll = node.scrollRect;
    const scrollState = scroll
      ? [scroll.x, scroll.y, scroll.width, scroll.height]
      : [];
    if (!same(r.scrollState, scrollState)) {
      dirty(r);
      r.scrollState = scrollState;
    }
    r.content.position.set(scroll ? -scroll.x : 0, scroll ? -scroll.y : 0);
    if (scroll) {
      r.scrollMask ||= new Graphics();
      const rect = [scroll.width, scroll.height];
      if (!same(r.scrollKey, rect)) {
        r.scrollMask
          .clear()
          .rect(0, 0, ...rect)
          .fill(0xffffff);
        r.scrollKey = rect;
      }
      r.outer.addChild(r.scrollMask);
      r.content.mask = r.scrollMask;
    } else {
      r.content.mask = null;
      r.scrollMask?.removeFromParent();
    }
    // Multiple timeline masks intersect by nesting containers. Script masks can
    // refer to a different branch of the display list; resolve after the walk.
    const maskNodes = [
      ...(node._timelineMasks || []),
      ...(node.mask ? [node.mask] : []),
    ];
    if (!same(r.maskNodes, maskNodes)) dirty(r);
    r.maskNodes = maskNodes;
    r.node = node;
    const blend = node.blendMode || "normal";
    const filters = node.filters || [];
    const sx = Math.hypot(world.a, world.b),
      sy = Math.hypot(world.c, world.d);
    let hasFilter = false;
    const descriptions = filters
      .map((f) => {
        if (!f) return null;
        hasFilter = true;
        const d = describeFilter(f, sx, sy, r.hasText);
        if (!d) missing("filter:" + f.filterName);
        else if (f.filterName !== "colorMatrix")
          missing("approximate-filter:" + f.filterName);
        return d;
      })
      .filter(Boolean);
    if (!["normal", "layer", ""].includes(blend))
      missing("blend-group:" + blend);
    r.cacheSafe =
      cacheSafe && !maskNodes.length && ["normal", "layer", ""].includes(blend);
    // An unfiltered, unmasked single draw needs no offscreen group for fixed
    // blend modes. Keep multi-draw groups isolated so overlapping children are
    // composited together before blending against the backdrop.
    const simple = !hasFilter && !maskNodes.length && !scroll;
    r.rasterSafe = rasterSafe && simple && !node.maskMode && ["normal", ""].includes(blend);
    // Content whose Pixi representation depends on the world linear transform:
    // scale-aware filters, native text resolution, screen-space stroke
    // extrusion, scenery raster resolution and 3D. Everything else follows the
    // ancestor's Pixi transform and needs no re-preparation on rotate/scale.
    r.transformSensitive = hasFilter || !!r.nativeText || !!r.screenStrokes || r.is3D ||
      (r.rasterSafe && drawCost >= 64);
    r.subtreeTransformSensitive = r.transformSensitive || childSensitive;
    r.drawCost = drawCost;
    r.batchVertices = batchVertices;
    // A small morph/timeline shape can invalidate a huge parent's batch even
    // though it never reaches the normal grouping threshold. Isolate it once
    // it changes layout, but only if this protects a substantial neighbor set.
    // Consult the nearest existing group's previous budget; promoting a child
    // below will remove it from the parent's budget during this same walk.
    let protectNeighbors = false;
    if (renderGroups && isolateTopology && !r.batchGroup && r.changingTopology) {
      for (let parent = node.parent; parent; parent = parent.parent) {
        const owner = records.get(parent);
        if (owner?.batchGroup || !parent.parent) {
          protectNeighbors = (owner?.batchVertices || 0) - batchVertices >= isolateNeighbors;
          break;
        }
      }
    }
    // Bound rebuilds caused by animated topology to a branch's instruction set.
    // Count vertices as well as draws: a few detailed shapes can otherwise
    // rebuild multi-megabyte buffers. Child groups are excluded from this budget.
    // Unary wrappers need no extra group; large standalone geometry does.
    // Promotion is persistent so animation does not toggle grouping every frame.
    // A masked object must share its mask's render group: Pixi renders a
    // stencil mask with the mask container's group-relative transform inside
    // the masked group's instruction set, so a promoted masked object clips
    // at the wrong place (inventory lists spilled past their mask).
    if (renderGroups && !r.batchGroup && !maskNodes.length && (
      (drawingChildren >= 2 && (drawCost >= 64 || (groupVertexLimit > 0 && batchVertices >= groupVertexLimit))) ||
      ownVertices >= 12000 || protectNeighbors
    )) {
      r.outer.enableRenderGroup();
      r.batchGroup = true;
      visualDirty = true;
    }
    if (r.batchGroup && maskNodes.length) {
      r.outer.disableRenderGroup();
      r.batchGroup = false;
      visualDirty = true;
    }
    if (r.batchGroup) stats.batchGroups++;
    // Several own draws that never overlap each other composite identically
    // whether blended one by one or as an isolated group.
    const disjointDraws = () => {
      const boxes = [];
      const objects = [];
      for (const m of r.meshes) if (m?.mesh.visible) objects.push(m.mesh);
      for (const c of singleChildren) objects.push(c.outer);
      for (const object of objects) {
        const b = object.getBounds();
        for (const o of boxes)
          if (b.minX < o.maxX && b.maxX > o.minX && b.minY < o.maxY && b.maxY > o.minY) return false;
        boxes.push({ minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY });
      }
      return true;
    };
    const blendable = ["add", "multiply", "screen"].includes(blend);
    const multiDirect = directMultiBlend && simple && blendable && singleDraws > 1 &&
      singleDraws <= 6 && drawingChildren === singleChildren.length && disjointDraws();
    const directBlend = simple && blendable && (singleDraws === 1 || multiDirect);
    r.singleDraws = simple && ["normal", ""].includes(blend) ? singleDraws : 2;
    if (directBlend) stats.directBlendGroups++;
    if (multiDirect) stats.directMultiBlendGroups++;
    else if (!["normal", "layer", ""].includes(blend))
      stats.isolatedBlendGroups++;
    const key = JSON.stringify([
      blend,
      descriptions,
      r.cacheSafe,
      directBlend,
      r.hasText,
    ]);
    if (r.filterKey !== key) {
      dirty(r);
      const layout = JSON.stringify([blend, descriptions.map(filterProgramKey), r.cacheSafe, directBlend, r.hasText]);
      if (reuseFilters && r.filterLayout === layout) {
        descriptions.forEach((d, i) => updateFilter(r.filters[i], d));
        r.effectCache?.refresh();
      } else {
        r.content.filters = null;
        r.effectCache?.destroy();
        r.effectCache = null;
        for (const f of r.filters) destroyFilter(f);
        r.filters = descriptions.map(createFilter);
        r.content.blendMode = directBlend ? blend : "inherit";
        if (!directBlend && !["normal", "layer", ""].includes(blend)) {
          const mapped = blend === "hardlight" ? "hard-light" : blend;
          if (
            [
              "add",
              "multiply",
              "screen",
              "overlay",
              "hard-light",
              "darken",
              "lighten",
              "difference",
            ].includes(mapped)
          ) {
            const AdvancedBlend = advancedBlends[mapped];
            const isolate = AdvancedBlend
              ? new AdvancedBlend()
              : new AlphaFilter({ alpha: 1 });
            if (!AdvancedBlend) isolate.blendMode = mapped;
            r.filters.push(isolate);
          } else missing("blend:" + blend);
        }
        // Text must be antialiased before sampling it into an effect texture.
        // Pixi filters default to non-MSAA inputs, unlike the main canvas.
        if (r.hasText) for (const f of r.filters) f.antialias = "on";
        if (cacheEffects && r.cacheSafe && r.filters.length)
          r.effectCache = new RetainedEffects(r.filters, stats);
        r.content.filters = r.effectCache
          ? [r.effectCache]
          : r.filters.length
            ? r.filters
            : null;
        r.filterLayout = layout;
      }
      r.filterKey = key;
    }
    // Pixi measures a filtered container's subtree on every frame to size the
    // filter texture (10 percent of a filter-heavy frame). Give it the area
    // from the cached local bounds instead, refreshed only when the subtree's
    // visual revision changed; Pixi still pads it for the filter.
    if (r.content.filters) {
      // Refresh on every visit: a child that only translates does not advance
      // this record's revision, and a stale area clipped glows and blurs for
      // a frame (flashing). Pixi caches getLocalBounds by change ticks, and
      // untouched branches are not visited at all.
      {
        const b = r.content.getLocalBounds();
        if (b.maxX > b.minX && b.maxY > b.minY) {
          (r.filterArea ||= new Rectangle()).set(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
          if (r.content.filterArea !== r.filterArea) r.content.filterArea = r.filterArea;
        } else if (r.content.filterArea) r.content.filterArea = null;
        stats.filterAreaUpdates++;
      }
    } else if (r.content.filterArea) r.content.filterArea = null;
    if (r.effectCache)
      r.effectCache.revision = Math.max(r.revision, transformRevision);
    scenery?.observe(r);
    effectTextureCache?.observe(r);
    if (before) finishSummary(r, before);
    if (gateRoot) {
      arrivalRoot = null;
      if (r.arrivalPreparedCount) r.arrivalPerShapeMs = r.arrivalPreparedMs / r.arrivalPreparedCount;
      if (r.arrivalIncomplete) {
        r.arrivalGated = true;
        r.arrivalFrames = (r.arrivalFrames || 0) + 1;
        r.outer.visible = false;
        stats.arrivalHidden++;
        sourceChanged(r, false, false);
        visualDirty = true;
        // A room-scale arrival would show as black areas while its layers
        // convert (the game already shows the room). Keep the previous
        // picture on screen instead; timelines, sockets and input keep
        // running, which is what the old one-frame freeze did not allow.
        const remaining = r.arrivalDeferredCount * (r.arrivalPerShapeMs || 0);
        // Default: never show a partially prepared scene; hold the previous
        // picture (at most arrivalMaxFrames). arrivalHide=1 restores hiding
        // small arrivals over existing content, which flashed in practice.
        if (!arrivalHide || r.arrivalBottom || r.arrivalSpent + remaining >= arrivalFreezeMs) arrivalFreeze = true;
      } else if (r.arrivalGated) {
        r.arrivalGated = false;
        r.arrivalFrames = 0;
        dirty(r, "arrival");
      }
    }
    path.delete(node);
    return r.outer;
  }
  function resolveMasks() {
    for (const r of records.values())
      if (r.epoch === stats.frames) {
        // Opt-in (maskGroups=1), unsafe: a mask whose content keeps changing
        // (skill cooldown wedges change frame every frame) rebuilds the whole
        // group of the content it clips (the action bar, about 1000
        // containers, every frame). Promoting the mask to its own render
        // group cut that to 35 containers, but content drawn after a masked
        // icon (the key numbers) disappeared: Pixi's stencil pop does not
        // restore state for a render-group mask.
        if (renderGroups && maskGroups) for (const n of r.maskNodes || []) {
          const t = records.get(n);
          // Only timeline masks (a MovieClip whose frames animate, like the
          // cooldown wedges). Promoting a TextField's crop mask lost the text.
          if (!t || t.batchGroup || n.assetType !== "[asset MovieClip]" || n.parentTextField) continue;
          if (t.maskRevision !== undefined && t.revision !== t.maskRevision && ++t.maskChanges >= 3) {
            t.outer.enableRenderGroup();
            t.batchGroup = true;
            visualDirty = true;
            stats.maskGroups = (stats.maskGroups || 0) + 1;
          }
          t.maskChanges ||= 0;
          t.maskRevision = t.revision;
        }
        const targets =
          r.maskNodes
            ?.map((n) => records.get(n)?.outer)
            .filter((t) => t && t !== r.outer) || [];
        if (targets.length !== (r.maskNodes?.length || 0))
          missing("detached-mask");
        let child = r.content;
        for (let i = 0; i < targets.length; i++) {
          const wrapper = (r.wrappers[i] ||= new Container());
          if (child.parent !== wrapper) wrapper.addChild(child);
          wrapper.mask = targets[i];
          child = wrapper;
        }
        while (r.wrappers.length > targets.length) {
          const wrapper = r.wrappers.pop();
          wrapper.mask = null;
          wrapper.removeChildren();
          wrapper.destroy();
        }
        if (child.parent !== r.outer) r.outer.addChildAt(child, 0);
      }
  }
  function destroyRecord(r) {
    hitStateNodes.delete(r.node);
    scenery?.release(r);
    effectTextureCache?.release(r);
    needsSweep = true;
    bindings?.release(r.node);
    tracker.releaseOwner(r);
    r.childLayer?.removeChildren();
    r.childLayer?.destroy();
    for (const w of r.wrappers) w.mask = null;
    visualDirty = true;
    r.content.mask = null;
    r.content.filters = null;
    // Descendants have their own records; do not destroy them twice.
    r.content.removeChildren();
    r.outer.removeChildren();
    for (const m of r.meshes) if (m) disposeMesh(m);
    r.effectCache?.destroy();
    for (const f of r.filters) destroyFilter(f);
    for (const w of r.wrappers) {
      w.removeChildren();
      w.destroy();
    }
    r.billboard?.destroy();
    retireNativeText(r);
    r.scrollMask?.destroy();
    r.content.destroy();
    r.outer.destroy();
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    profiler.stop();
    restoreCatchUp?.();
    restoreIdleHover?.();
    restorePixiPickBounds?.();
    restorePixiPickEvents?.();
    bindings?.destroy();
    detachedRecords.clear();
    stats.active = false;
    if (failed) player.isPaused = pauseBeforeFailure;
    if (native.render === render) native.render = original;
    scenery?.destroy();
    effectTextureCache?.destroy();
    scene.removeChildren();
    for (const r of records.values()) for (const w of r.wrappers) w.mask = null;
    for (const r of records.values()) destroyRecord(r);
    records.clear();
    geometryCache.destroy();
    nativePaths.destroy();
    nativePicking.destroy();
    if (pixiBitmapDraw) pathSource?.setBitmapDrawHandler(null);
    pathSource?.setLiteGeometry(false);
    for (const r of textures.values())
      for (const t of r.variants.values()) retirePixiTexture(t);
    textures.clear();
    textureSamples.destroy();
    tracker.destroy();
    scene.destroy();
    canvas.removeEventListener("webglcontextlost", contextLost);
    restoreBlendResolve?.();
    restoreVectorBatcher?.();
    renderer.destroy();
    canvas.remove();
    onStatus("AwayFL renderer active", stats);
  }
  function fail(error) {
    if (stopped || failed) return;
    failed = true;
    stats.failed = true;
    stats.lastError = error.message;
    pauseBeforeFailure = player.isPaused;
    player.isPaused = true;
    console.error("[Pixi display list]", error);
    onStatus("Pixi paused: " + error.message + ". Reload to retry or select Use AwayFL.", stats);
  }
  function render() {
    if (stopped || failed) return;
    let endPhase;
    try {
      const start = performance.now();
      endPhase = profiler.section("syncSetupMs");
      stats.preparedNodes = stats.skippedSubtrees = 0;
      stats.preparedContents = stats.retainedContents = 0;
      stats.nativeGraphics = stats.nativeGradients = stats.nativeBitmaps = stats.nativeCompounds = stats.nativeTexts = stats.nodes = stats.meshes = stats.batchedMeshes = stats.customMeshes = stats.vectorBatchedMeshes = 0;
      stats.directBlendGroups = stats.isolatedBlendGroups = stats.directMultiBlendGroups = 0;
      stats.batchGroups = 0;
      stats.unsupported = {};
      tracker.epoch = stats.frames;
      arrivalSpent = 0;
      arrivalFreeze = false;
      textureSamples.flush();
      const width = sourceCanvas.width,
        height = sourceCanvas.height;
      const rect = sourceCanvas.getBoundingClientRect();
      canvas.style.left = rect.left + "px";
      canvas.style.top = rect.top + "px";
      canvas.style.width = rect.width + "px";
      canvas.style.height = rect.height + "px";
      if (renderer.width !== width || renderer.height !== height) {
        visualDirty = true;
        renderer.resize(width, height);
      }
      stats.renderSize[0] = width;
      stats.renderSize[1] = height;
      const p = player._view.viewMatrix3D._rawData,
        w = p[15];
      if (!w || p[3] || p[7])
        throw Error("Display-list prototype supports orthographic 2D stages");
      const projection = new Matrix(
        (width * 0.5 * p[0]) / w,
        (-height * 0.5 * p[1]) / w,
        (width * 0.5 * p[4]) / w,
        (-height * 0.5 * p[5]) / w,
        width * 0.5 * (p[12] / w + 1),
        height * 0.5 * (1 - p[13] / w),
      );
      const projectionKey = [
        projection.a,
        projection.b,
        projection.c,
        projection.d,
        projection.tx,
        projection.ty,
      ];
      if (!same(previousProjection, projectionKey)) {
        visualDirty = true;
        if (bindings) sourceChanged(records.get(player.root), true);
        else for (const r of records.values()) dirty(r);
      }
      previousProjection = projectionKey;
      scene.setFromMatrix(projection);
      endPhase?.(); endPhase = profiler.section("syncVisitMs");
      const root = visit(player.root, IDENTITY_COLOR, new Set(), projection);
      if (root.parent !== scene) scene.addChild(root);
      endPhase?.(); endPhase = profiler.section("syncMasksMs");
      if (stats.preparedNodes) { stats.preparationPasses++; resolveMasks(); }
      else stats.reusedPreparations++;
      endPhase?.(); endPhase = profiler.section("syncRetireMs");
      if (bindings) retireDetached();
      else for (const [node, r] of records)
        if (r.epoch < stats.frames - 2) {
          destroyRecord(r);
          records.delete(node);
        }
      endPhase?.(); endPhase = profiler.section("syncSceneryMs");
      scenery?.prepare();
      effectTextureCache?.prepare();
      endPhase?.(); endPhase = undefined;
      stats.syncMs = performance.now() - start;
      const draw = performance.now();
      // Reuse the completed canvas only when every observable drawing input
      // stayed unchanged. Timelines and input still run, and we still synchronize
      // the display list so mutations trigger a new draw immediately.
      if (arrivalFreeze) stats.arrivalFrozen++;
      if (!arrivalFreeze && (
        visualDirty ||
        previousBuilds !== stats.geometryBuilds ||
        previousUploads !== stats.textureUploads
      )) {
        // Diagnostics: stats.traceGroups = true records which render groups
        // rebuild their instructions this frame and how large they are.
        if (stats.traceGroups) {
          const dirty = [];
          let total = 0;
          for (const r of records.values()) {
            const group = r.outer.renderGroup;
            if (!group) continue;
            total++;
            if (group.structureDidChange) {
              let count = 0;
              const walk = c => { count++; for (const k of c.children) walk(k); };
              walk(r.outer);
              const names = [];
              for (let n = r.node; n && names.length < 4; n = n.parent)
                names.push(n.name || n.adapter?.axClass?.name?.name || n.assetType);
              dirty.push({ path: names.join("<"), containers: count, frame: stats.frames });
            }
          }
          (stats.groupTrace ||= []).push({ frame: stats.frames, total, dirty: dirty.length, containers: dirty.reduce((a, d) => a + d.containers, 0), top: dirty.sort((a, b) => b.containers - a.containers).slice(0, 6) });
        }
        renderer.render({ container: scene, clear: true });
        // Pixi HTMLText creates its SVG texture asynchronously. Its render
        // group becomes dirty on completion, but our unchanged-frame shortcut
        // also needs to request one more render to put it on the canvas.
        for (const r of records.values()) {
          const texts = r.nativeText?.children?.length ? r.nativeText.children : [r.nativeText];
          for (const text of texts) {
            if (text?.renderPipeId !== "htmlText") continue;
            const promise = text._gpuData[renderer.uid]?.texturePromise;
            if (promise && !observedHTMLTextures.has(promise)) {
              observedHTMLTextures.add(promise);
              // Advance the record's revision too: a scenery cache or retained
              // effect that snapshotted the empty placeholder only refreshes
              // on a revision change, so the label could stay invisible.
              promise.then(() => {
                if (stopped) return;
                visualDirty = true;
                if (records.get(r.node) === r) { dirty(r, "text-texture"); sourceChanged(r); }
              }).catch(() => {});
            }
          }
        }
        stats.drawnFrames++;
        stats.pixiMs = performance.now() - draw;
      } else {
        stats.reusedFrames++;
        stats.pixiMs = 0;
      }
      visualDirty = arrivalFreeze;
      previousBuilds = stats.geometryBuilds;
      previousUploads = stats.textureUploads;
      endPhase = profiler.section("adapterCleanupMs");
      // Retirement happens after render instructions release last frame's textures.
      for (const [image, r] of textures)
        if (!tracker.retained(image) && !textureSamples.retained(image) &&
            ![...r.variants.values()].some(nativePaths.usesTexture) && r.epoch < stats.frames - 2) {
          for (const t of r.variants.values()) retirePixiTexture(t);
          textures.delete(image);
        }
      if (!bindings || stats.preparedNodes || detachedRecords.size || needsSweep) {
        geometryCache.sweep();
        nativePaths.sweep();
        textureSamples.sweep();
        tracker.sweep();
        needsSweep = false;
      }
      stats.frames++;
      if (performance.now() - statusTime > 1000) {
        const now = performance.now();
        stats.fps = ((stats.frames - statusFrames) * 1000) / (now - statusTime);
        statusFrames = stats.frames;
        statusTime = now;
        onStatus(
          (directObjects ? "Pixi direct objects — " : "Pixi display list — ") +
            stats.fps.toFixed(1) +
            " FPS · prototype (" +
            Object.keys(stats.unsupported).length +
            " compatibility gaps)",
          stats,
        );
      }
    } catch (error) {
      fail(error);
    } finally {
      endPhase?.();
    }
  }
  function contextLost(event) {
    event.preventDefault();
    fail(Error("Pixi graphics context lost"));
  }
  canvas.addEventListener("webglcontextlost", contextLost);
  try {
    if (bindings) bindings.own(player.root);
  } catch (error) {
    stop();
    throw error;
  }
  native.render = render;
  if (nativeGraphics) pathSource.setLiteGeometry(true);
  if (pixiBitmapDraw && pathSource) pathSource.setBitmapDrawHandler(createBitmapDraw(renderer, records, stats));
  onStatus(directObjects ? "Pixi direct objects — prototype" : "Pixi display list — prototype", stats);
  return {
    stop,
    stats,
    profile: (count, options) => stopped ? Promise.reject(Error("Pixi is stopped")) : profiler.sample(count, options),
    inspectScenery: () => scenery?.inspect() || [],
    getDisplayObject: (node) => records.get(node?.adaptee || node)?.outer,
    // Diagnostics: the Pixi renderer, for GL-level probes from the console.
    get renderer() { return renderer; },
    traceBatchInputs: (on = true) => restoreVectorBatcher?.traceInputs?.(on),
    inspectText(search) {
      const result = [];
      for (const [node, r] of records) {
        if (
          node.type === "input" ||
          typeof node.text !== "string" ||
          !node.text.toLowerCase().includes(String(search).toLowerCase())
        )
          continue;
        const chain = [];
        for (let n = node; n; n = n.parent) {
          const rec = records.get(n);
          chain.push({
            name: n.name,
            color: Array.from(rec?.color || []),
            filters: rec?.filterKey,
            scale: rec?.world && [
              rec.world.a,
              rec.world.b,
              rec.world.c,
              rec.world.d,
            ],
          });
        }
        result.push({
          name: node.name,
          text: node.text,
          chain,
          meshes: r.meshes.filter(Boolean).map((m) => ({
            custom: m.custom,
            tint: m.mesh.tint,
            alpha: m.mesh.alpha,
            multiply: m.uniforms && Array.from(m.uniforms.uniforms.uMultiply),
            offset: m.uniforms && Array.from(m.uniforms.uniforms.uOffset),
            fill: m.shape.originalFillStyle,
            uv: m.shape.style?.uvMatrix,
            texture: [m.mesh.texture?.width, m.mesh.texture?.height],
          })),
        });
      }
      return result;
    },
    get active() {
      return !stopped;
    },
  };
}
