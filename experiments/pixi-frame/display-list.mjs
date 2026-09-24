import {
  WebGLRenderer,
  Container,
  Matrix,
  Mesh,
  Texture,
  BufferImageSource,
  Sprite,
  Shader,
  GlProgram,
  UniformGroup,
  Graphics,
  AlphaFilter,
} from "pixi.js";
import "./flash-blends.mjs";
import { createGeometryCache } from "./display-list-geometry.mjs";
import {
  describeFilter,
  createFilter,
  destroyFilter,
} from "./display-list-filters.mjs";
import { createAssetTracker, combineColor } from "./display-list-data.mjs";

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
const clamp = (v) => Math.max(0, Math.min(1, v));

// Experimental backend: walks display objects, never invokes AwayFL's root
// renderer. Own canvas/context/textures; no render-command capture or GPU readback.
export async function startDisplayList(player, { onStatus = () => {} } = {}) {
  const native = player._renderer;
  const original = native.render;
  const sourceCanvas = player._view.stage.context._gl.canvas;
  const canvas = sourceCanvas.ownerDocument.createElement("canvas");
  canvas.dataset.pixiDisplayList = "";
  canvas.style.cssText = "position:fixed;pointer-events:none;z-index:1;";
  const renderer = new WebGLRenderer();
  const paused = player.isPaused;
  player.isPaused = true;
  try {
    await renderer.init({
      canvas,
      width: sourceCanvas.width,
      height: sourceCanvas.height,
      resolution: 1,
      antialias: true,
      background: 0,
      backgroundAlpha: 1,
      useBackBuffer: true,
    });
    renderer.events?.setTargetElement(null);
  } catch (error) {
    renderer.destroy();
    throw error;
  } finally {
    player.isPaused = paused;
  }
  sourceCanvas.ownerDocument.body.append(canvas);
  const scene = new Container();
  const records = new Map(),
    textures = new Map();
  const tracker = createAssetTracker();
  const stats = {
    active: true,
    mode: "display-list",
    frames: 0,
    fps: 0,
    syncMs: 0,
    pixiMs: 0,
    nodes: 0,
    meshes: 0,
    batchedMeshes: 0,
    customMeshes: 0,
    geometryBuilds: 0,
    textureUploads: 0,
    renderSize: [0, 0],
    unsupported: {},
    lastError: null,
  };
  const geometryCache = createGeometryCache(tracker, stats);
  let stopped = false,
    statusTime = performance.now(),
    statusFrames = 0;
  let program;
  const missing = (reason) => {
    stats.unsupported[reason] = (stats.unsupported[reason] || 0) + 1;
  };
  function imageTexture(image, sampler) {
    if (!image || image.isDisposed || image.width <= 0 || image.height <= 0)
      return null;
    // BitmapData.draw still belongs to the Flash runtime. Never silently read
    // its GPU-only result back to the CPU (or upload a stale CPU copy).
    if (image._imageDataDirty) {
      missing("gpu-bitmap");
      return null;
    }
    // Keep native upload flags untouched; edits may coalesce until AwayFL
    // next uploads this bitmap, even though Pixi owns a separate texture.
    const version = tracker.version(image, "invalidateGPU");
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
      r.version = tracker.version(image);
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
    r.mesh.removeFromParent();
    r.mesh.destroy();
    r.shader?.destroy();
    geometryCache.release(r.geometryEntry);
  }
  function shapeMesh(shape, node, record, index, color) {
    const e = shape.elements;
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
    if (e.assetType === "[asset LineElements]") missing("stroke-extrusion");
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
    const texture = tex ? imageTexture(image, sampler) : Texture.WHITE;
    if (!texture) return null;
    const uv =
      style?.uvMatrix || node.style?.uvMatrix || material?.style?.uvMatrix;
    const curves = e.getCustomAtributes?.("curves");
    const radial = tex?.mappingMode === 1;
    const custom =
      !!curves ||
      radial ||
      color.some((c, i) => (i < 4 ? c < 0 || c > 1 : c !== 0));
    let r = record.meshes[index];
    if (r && r.custom !== custom) {
      disposeMesh(r);
      r = null;
    }
    const geometryEntry = geometryCache.sync(
      r?.geometryEntry,
      shape,
      uv,
      custom,
    );
    const geometry = geometryEntry.geometry;
    if (!r) {
      const mesh = new Mesh({ geometry, texture });
      r = record.meshes[index] = { shape, mesh, geometryEntry, custom };
      if (custom) {
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
    r.shape = shape;
    r.geometryEntry = geometryEntry;
    r.mesh.geometry = geometry;
    const mesh = r.mesh;
    mesh.texture = texture;
    mesh.visible = true;
    if (custom) {
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
      stats.customMeshes++;
    } else {
      const base = !tex ? (material?.style?.color ?? 0xffffff) : 0xffffff;
      const alpha = !tex ? (material?.ambientMethod?.alpha ?? 1) : 1;
      const rgb = [(base >> 16) & 255, (base >> 8) & 255, base & 255].map(
        (c, i) =>
          Math.round(clamp((c / 255) * color[i] + color[i + 4] / 255) * 255),
      );
      mesh.tint = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
      mesh.alpha = clamp(alpha * color[3] + color[7] / 255);
      stats.batchedMeshes++;
    }
    stats.meshes++;
    return mesh;
  }
  function arrange(container, children) {
    for (let i = 0; i < children.length; i++) {
      if (container.children[i] !== children[i])
        container.addChildAt(children[i], i);
    }
    while (container.children.length > children.length)
      container.removeChildAt(children.length);
  }
  function nodeRecord(node) {
    let r = records.get(node);
    if (!r) {
      r = {
        outer: new Container(),
        content: new Container(),
        meshes: [],
        color: new Float32Array(8),
        matrix: new Matrix(),
        wrappers: [],
        filterKey: null,
        filters: [],
      };
      r.outer.addChild(r.content);
      records.set(node, r);
    }
    return r;
  }
  function visit(
    node,
    inherited,
    path = new Set(),
    parentMatrix = scene.localTransform,
  ) {
    if (path.has(node)) {
      missing("cyclic-display-list");
      return null;
    }
    path.add(node);
    const r = nodeRecord(node);
    r.epoch = stats.frames;
    r.outer.visible = node.visible !== false;
    stats.nodes++;
    if (!r.outer.visible) {
      path.delete(node);
      return r.outer;
    }
    const entity = node.getEntity?.(); // Text glyph construction and lazy graphics only.
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
    const world = r.world || (r.world = new Matrix());
    world.set(
      parentMatrix.a * a[0] + parentMatrix.c * a[1],
      parentMatrix.b * a[0] + parentMatrix.d * a[1],
      parentMatrix.a * a[4] + parentMatrix.c * a[5],
      parentMatrix.b * a[4] + parentMatrix.d * a[5],
      0,
      0,
    );
    if (a[2] || a[6] || a[3] || a[7]) missing("3d-transform");
    const transform = [a[0], a[1], a[4], a[5], a[12], a[13]];
    if (!same(r.transform, transform)) {
      r.matrix.set(...transform);
      r.outer.setFromMatrix(r.matrix);
      r.transform = transform;
    }
    combineColor(inherited, node.transform.colorTransform?._rawData, r.color);
    const children = [];
    let shapeIndex = 0;
    if (entity?.assetType === "[asset Billboard]") {
      // Billboard geometry is generated on the CPU independently of render entities.
      const b = entity.billboardRect;
      const key = [entity.billboardWidth, entity.billboardHeight, b?.x, b?.y];
      if (!same(r.billboardKey, key)) {
        r.billboard?.destroy();
        r.billboard = new Sprite();
        r.billboardKey = key;
      }
      const texture = imageTexture(entity.image, entity.style?.sampler);
      if (texture) {
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
    } else
      entity?._acceptTraverser?.({
        applyTraversable(shape) {
          const mesh = shapeMesh(shape, node, r, shapeIndex++, r.color);
          if (mesh) children.push(mesh);
          else if (r.meshes[shapeIndex - 1]) {
            disposeMesh(r.meshes[shapeIndex - 1]);
            r.meshes[shapeIndex - 1] = null;
          }
        },
      });
    while (r.meshes.length > shapeIndex) {
      const old = r.meshes.pop();
      if (old) disposeMesh(old);
    }
    for (const child of node._children || []) {
      const object = visit(child, r.color, path, world);
      if (object) children.push(object);
    }
    arrange(r.content, children);
    const scroll = node.scrollRect;
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
    r.maskNodes = [
      ...(node._timelineMasks || []),
      ...(node.mask ? [node.mask] : []),
    ];
    r.node = node;
    const blend = node.blendMode || "normal";
    const filters = node.filters || [];
    const sx = Math.hypot(world.a, world.b),
      sy = Math.hypot(world.c, world.d);
    const descriptions = filters
      .map((f) => {
        const d = describeFilter(f, sx, sy);
        if (!d) missing("filter:" + f.filterName);
        else if (f.filterName !== "colorMatrix")
          missing("approximate-filter:" + f.filterName);
        return d;
      })
      .filter(Boolean);
    if (!["normal", "layer", ""].includes(blend))
      missing("blend-group:" + blend);
    const key = JSON.stringify([blend, descriptions]);
    if (r.filterKey !== key) {
      r.content.filters = null;
      for (const f of r.filters) destroyFilter(f);
      r.filters = descriptions.map(createFilter);
      if (!["normal", "layer", ""].includes(blend)) {
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
          const isolate = new AlphaFilter({ alpha: 1 });
          isolate.blendMode = mapped;
          r.filters.push(isolate);
        } else missing("blend:" + blend);
      }
      r.content.filters = r.filters.length ? r.filters : null;
      r.filterKey = key;
    }
    path.delete(node);
    return r.outer;
  }
  function resolveMasks() {
    for (const r of records.values())
      if (r.epoch === stats.frames) {
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
    for (const w of r.wrappers) w.mask = null;
    r.content.mask = null;
    r.content.filters = null;
    // Descendants have their own records; do not destroy them twice.
    r.content.removeChildren();
    r.outer.removeChildren();
    for (const m of r.meshes) if (m) disposeMesh(m);
    for (const f of r.filters) destroyFilter(f);
    for (const w of r.wrappers) {
      w.removeChildren();
      w.destroy();
    }
    r.billboard?.destroy();
    r.scrollMask?.destroy();
    r.content.destroy();
    r.outer.destroy();
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    stats.active = false;
    if (native.render === render) native.render = original;
    scene.removeChildren();
    for (const r of records.values()) for (const w of r.wrappers) w.mask = null;
    for (const r of records.values()) destroyRecord(r);
    records.clear();
    geometryCache.destroy();
    for (const r of textures.values())
      for (const t of r.variants.values()) t.destroy(true);
    textures.clear();
    tracker.destroy();
    scene.destroy();
    canvas.removeEventListener("webglcontextlost", contextLost);
    renderer.destroy();
    canvas.remove();
    onStatus("AwayFL renderer active", stats);
  }
  function render(...args) {
    if (stopped) return original.apply(this, args);
    try {
      const start = performance.now();
      stats.nodes = stats.meshes = stats.batchedMeshes = stats.customMeshes = 0;
      stats.unsupported = {};
      tracker.epoch = stats.frames;
      const width = sourceCanvas.width,
        height = sourceCanvas.height;
      const rect = sourceCanvas.getBoundingClientRect();
      canvas.style.left = rect.left + "px";
      canvas.style.top = rect.top + "px";
      canvas.style.width = rect.width + "px";
      canvas.style.height = rect.height + "px";
      if (renderer.width !== width || renderer.height !== height)
        renderer.resize(width, height);
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
      scene.setFromMatrix(projection);
      const root = visit(player.root, IDENTITY_COLOR, new Set(), projection);
      if (root.parent !== scene) scene.addChild(root);
      resolveMasks();
      for (const [node, r] of records)
        if (r.epoch < stats.frames - 2) {
          destroyRecord(r);
          records.delete(node);
        }
      stats.syncMs = performance.now() - start;
      const draw = performance.now();
      renderer.render({ container: scene, clear: true });
      stats.pixiMs = performance.now() - draw;
      // Retirement happens after render instructions release last frame's textures.
      for (const [image, r] of textures)
        if (r.epoch < stats.frames - 2) {
          for (const t of r.variants.values()) t.destroy(true);
          textures.delete(image);
        }
      geometryCache.sweep();
      tracker.sweep();
      stats.frames++;
      if (performance.now() - statusTime > 1000) {
        const now = performance.now();
        stats.fps = ((stats.frames - statusFrames) * 1000) / (now - statusTime);
        statusFrames = stats.frames;
        statusTime = now;
        onStatus(
          "Pixi display list — " +
            stats.fps.toFixed(1) +
            " FPS · prototype (" +
            Object.keys(stats.unsupported).length +
            " compatibility gaps)",
          stats,
        );
      }
    } catch (error) {
      stats.lastError = error.message;
      console.error("[Pixi display list]", error);
      stop();
      original.apply(this, args);
      onStatus("Pixi stopped: " + error.message, stats);
    }
  }
  function contextLost(event) {
    event.preventDefault();
    stats.lastError = "Pixi graphics context lost";
    stop();
  }
  canvas.addEventListener("webglcontextlost", contextLost);
  native.render = render;
  onStatus("Pixi display list — prototype", stats);
  return {
    stop,
    stats,
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
            texture: [m.mesh.texture.width, m.mesh.texture.height],
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
