import {
  WebGLRenderer,
  Container,
  Mesh,
  Geometry,
  Buffer,
  BufferUsage,
  Shader,
  GlProgram,
  UniformGroup,
  Texture,
  TextureSource,
  Sprite,
  Rectangle,
} from "pixi.js";
import "./flash-blends.mjs";

const types = {
  5126: "f32",
  5124: "i32",
  35664: "vec2<f32>",
  35665: "vec3<f32>",
  35666: "vec4<f32>",
  35674: "mat2x2<f32>",
  35675: "mat3x3<f32>",
  35676: "mat4x4<f32>",
};

// A persistent Pixi display list. AwayFL textures stay on the same GPU/context.
export async function createLiveRenderer(gl) {
  const css = gl.canvas.style.cssText;
  const renderer = new WebGLRenderer();
  await renderer.init({
    context: gl,
    canvas: gl.canvas,
    width: gl.drawingBufferWidth,
    height: gl.drawingBufferHeight,
    resolution: 1,
    autoDensity: false,
    antialias: true,
    backgroundColor: 0,
    backgroundAlpha: 1,
    useBackBuffer: true,
  });
  renderer.events?.setTargetElement(null);
  gl.canvas.style.cssText = css;
  // The context belongs to AwayFL; stopping this bridge must not lose it.
  renderer.context.extensions.loseContext = null;
  renderer.texture._useSeparateSamplers = true;
  const scene = new Container(),
    records = new Map(),
    sourceRecords = new Map(),
    borrowed = new Map(),
    programs = new Map();
  let nextId = 0,
    epoch = 0;
  function texture(t) {
    let record = borrowed.get(t);
    if (!record) {
      const source = new TextureSource({
        width: t.width,
        height: t.height,
        resolution: 1,
        alphaMode: "premultiplied-alpha",
        scaleMode: t.scaleMode,
        addressMode: t.addressMode,
        autoGarbageCollect: false,
      });
      // External resources are deliberately not registered with Pixi's texture GC.
      source._gpuData[renderer.uid] = {
        texture: t.handle,
        target: gl.TEXTURE_2D,
        width: t.width,
        height: t.height,
        type: gl.UNSIGNED_BYTE,
        format: gl.RGBA,
        internalFormat: gl.RGBA,
        samplerType: 0,
        destroy() {},
      };
      record = { source, texture: new Texture({ source }), epoch };
      borrowed.set(t, record);
    }
    record.epoch = epoch;
    record.source.style.scaleMode = t.scaleMode;
    record.source.style.addressMode = t.addressMode;
    const gpu = record.source._gpuData[renderer.uid];
    gpu.texture = t.handle;
    gpu.width = t.width;
    gpu.height = t.height;
    if (record.source.width !== t.width || record.source.height !== t.height) {
      record.source.resize(t.width, t.height);
      record.texture.update();
    }
    return record.texture;
  }
  function vertex(g) {
    if (g.nativeProjection) return g.vertex;
    return (
      g.vertex.replace(/void\s+main\s*\(/, "void awayMain(") +
      `
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uAwayViewport;
void main(){awayMain();vec2 p=gl_Position.xy/gl_Position.w;p=p*vec2(0.5,${g.offscreen ? "0.5" : "-0.5"})+0.5;p=p*uAwayViewport.zw+uAwayViewport.xy;gl_Position=vec4((uProjectionMatrix*uWorldTransformMatrix*uTransformMatrix*vec3(p,1.0)).xy,0.0,1.0);}`
    );
  }
  function mesh(g, resourceList) {
    const attributes = {};
    for (const [name, a] of Object.entries(g.attributes))
      attributes[name] = {
        buffer: new Buffer({ data: a.data, usage: BufferUsage.VERTEX }),
        format: "float32" + (a.size > 1 ? "x" + a.size : ""),
        stride: a.size * 4,
      };
    const v = vertex(g),
      key = v + g.fragment;
    if (!programs.has(key))
      programs.set(key, GlProgram.from({ vertex: v, fragment: g.fragment }));
    const values = {
      uAwayViewport: { type: "vec4<f32>", value: new Float32Array(4) },
    };
    for (const [name, u] of Object.entries(g.uniforms)) {
      if (!types[u.type]) throw Error("Unsupported live uniform " + u.type);
      values[name] = {
        type: types[u.type],
        size: u.size,
        value: Array.isArray(u.value) ? new Float32Array(u.value) : u.value,
      };
    }
    const group = new UniformGroup(values),
      resources = { captured: group };
    for (const [name, t] of Object.entries(g.samplers))
      resources[name] = texture(t).source;
    const shader = new Shader({ glProgram: programs.get(key), resources });
    const geometry = new Geometry({ attributes, topology: "triangle-list" }),
      object = new Mesh({ geometry, shader });
    resourceList.push(() => {
      geometry.destroy(true);
      shader.destroy();
    });
    return {
      object,
      update(g) {
        for (const [name, a] of Object.entries(g.attributes))
          if (geometry.attributes[name].buffer.data !== a.data)
            geometry.attributes[name].buffer.data = a.data;
        let changed = false;
        function updateUniform(name, value) {
          const previous = group.uniforms[name];
          if (Array.isArray(value)) {
            if (value.some((v, i) => previous[i] !== Math.fround(v))) {
              previous.set(value);
              changed = true;
            }
          } else if (previous !== value) {
            group.uniforms[name] = value;
            changed = true;
          }
        }
        updateUniform("uAwayViewport", [
          g.viewport.x,
          g.viewport.y,
          g.viewport.width,
          g.viewport.height,
        ]);
        for (const [name, u] of Object.entries(g.uniforms))
          updateUniform(name, u.value);
        if (changed) group.update();
        for (const [name, t] of Object.entries(g.samplers)) {
          const source = texture(t).source;
          if (shader.resources[name] !== source)
            shader.resources[name] = source;
        }
        object.blendMode = g.blend;
        const b = g.bounds || g.viewport;
        Object.assign(geometry._bounds, {
          minX: b.x,
          minY: b.y,
          maxX: b.x + b.width,
          maxY: b.y + b.height,
        });
        geometry._boundsDirty = false;
      },
    };
  }
  const shaderIds = new Map();
  const geometrySignature = (g) => {
    // Shader strings are shared by thousands of recipes. Avoid concatenating
    // and hashing the entire GLSL sources again for every mesh on every frame.
    let fragments = shaderIds.get(g.vertex);
    if (!fragments) shaderIds.set(g.vertex, (fragments = new Map()));
    let shaderId = fragments.get(g.fragment);
    if (!shaderId) fragments.set(g.fragment, (shaderId = ++nextId));
    return [
      Object.entries(g.attributes)
        .map(([n, a]) => n + ":" + a.size + ":" + a.data.length)
        .join(","),
      shaderId,
      !!g.offscreen,
      !!g.nativeProjection,
      Object.keys(g.samplers).join(","),
    ].join("|");
  };
  function signature(c) {
    return [
      c.kind,
      ...(c.geometry || []).map(geometrySignature),
      ...c.masks.map((m) => m.map(geometrySignature).join(";")),
    ].join("\n");
  }
  function create(c) {
    const group = new Container(),
      resources = [],
      updates = [];
    let sprite, crop;
    if (c.kind === "cache") {
      const t = texture(c.pixels);
      crop = new Texture({
        dynamic: true,
        source: t.source,
        frame: new Rectangle(0, 0, c.bounds.width, c.bounds.height),
      });
      sprite = new Sprite(crop);
      group.addChild(sprite);
      resources.push(() => crop.destroy());
    } else
      for (const g of c.geometry) {
        const m = mesh(g, resources);
        updates.push(m);
        group.addChild(m.object);
      }
    const maskUpdates = [];
    let outer = group;
    for (const layer of c.masks) {
      const parent = new Container(),
        mask = new Container(),
        ms = [];
      for (const g of layer) {
        const m = mesh(g, resources);
        ms.push(m);
        mask.addChild(m.object);
      }
      parent.addChild(outer, mask);
      outer.mask = mask;
      outer = parent;
      maskUpdates.push(ms);
    }
    return {
      object: outer,
      signature: signature(c),
      update(c) {
        if (sprite) {
          const t = texture(c.pixels);
          if (
            crop.source !== t.source ||
            crop.frame.width !== c.bounds.width ||
            crop.frame.height !== c.bounds.height
          ) {
            crop.source = t.source;
            Object.assign(crop.frame, {
              x: 0,
              y: 0,
              width: c.bounds.width,
              height: c.bounds.height,
            });
            crop.orig.copyFrom(crop.frame);
            crop.update();
          }
          sprite.position.set(c.bounds.x, c.bounds.y);
          sprite.width = c.bounds.width;
          sprite.height = c.bounds.height;
          group.blendMode = c.blend === "layer" ? "normal" : c.blend;
        } else c.geometry.forEach((g, i) => updates[i].update(g));
        c.masks.forEach((layer, i) =>
          layer.forEach((g, j) => maskUpdates[i][j].update(g)),
        );
      },
      destroy() {
        outer.removeFromParent();
        outer.destroy({ children: true });
        resources.forEach((fn) => fn());
      },
    };
  }
  return {
    renderer,
    scene,
    texture,
    drawSources(entries) {
      // Only reset Pixi's binding caches. A full renderer.resetState() would
      // replace the caller's stencil/depth state and multisampled framebuffer.
      renderer.shader.resetState();
      renderer.geometry.resetState();
      renderer.texture.resetState();
      const factors = [
        gl.DST_ALPHA,
        gl.DST_COLOR,
        gl.ONE,
        gl.ONE_MINUS_DST_ALPHA,
        gl.ONE_MINUS_DST_COLOR,
        gl.ONE_MINUS_SRC_ALPHA,
        gl.ONE_MINUS_SRC_COLOR,
        gl.SRC_ALPHA,
        gl.SRC_COLOR,
        gl.ZERO,
      ];
      const equations = [
        gl.FUNC_ADD,
        gl.FUNC_SUBTRACT,
        gl.FUNC_REVERSE_SUBTRACT,
        gl.MIN,
        gl.MAX,
      ];
      const comparisons = [
        gl.ALWAYS,
        gl.EQUAL,
        gl.GREATER,
        gl.GEQUAL,
        gl.LESS,
        gl.LEQUAL,
        gl.NEVER,
        gl.NOTEQUAL,
      ];
      for (const { key, recipe: g } of entries) {
        const sig = geometrySignature(g);
        let r = sourceRecords.get(key);
        if (!r || r.signature !== sig) {
          r?.destroy();
          const resources = [],
            m = mesh(g, resources);
          r = {
            ...m,
            signature: sig,
            destroy() {
              m.object.destroy();
              resources.forEach((f) => f());
            },
          };
          sourceRecords.set(key, r);
        }
        r.epoch = epoch;
        r.update(g);
        const state = g.raster,
          f = state.blendFactors;
        gl.enable(gl.BLEND);
        gl.blendEquationSeparate(
          ...state.blendEquations.map((i) => equations[i]),
        );
        gl.blendFuncSeparate(
          factors[f[0]],
          factors[f[1]],
          factors[f[2] ?? f[0]],
          factors[f[3] ?? f[1]],
        );
        gl.depthMask(state.depthWrite);
        gl.depthFunc(comparisons[state.depthCompare]);
        if (state.cull === null) gl.disable(gl.CULL_FACE);
        else {
          gl.enable(gl.CULL_FACE);
          gl.cullFace(state.cull);
        }
        renderer.encoder.draw({
          geometry: r.object.geometry,
          shader: r.object.shader,
        });
      }
    },
    render(frame) {
      epoch++;
      if (renderer.width !== frame.width || renderer.height !== frame.height)
        renderer.resize(frame.width, frame.height, 1);
      const used = new Set();
      let index = 0;
      for (const c of frame.commands) {
        let r = records.get(c.key);
        const sig = signature(c);
        if (!r || r.signature !== sig) {
          r?.destroy();
          r = create(c);
          records.set(c.key, r);
        }
        used.add(c.key);
        r.update(c);
        if (scene.children[index] !== r.object)
          scene.addChildAt(r.object, index);
        index++;
      }
      for (const [k, r] of records)
        if (!used.has(k)) {
          r.destroy();
          records.delete(k);
        }
      for (const [k, r] of sourceRecords)
        if (epoch - r.epoch > 120) {
          r.destroy();
          sourceRecords.delete(k);
        }
      for (const [k, t] of borrowed)
        if (epoch - t.epoch > 120 && !t.source.listenerCount("change")) {
          // Pixi bind groups (including retained renderer batches) subscribe to
          // source changes. A live binding owns the wrapper beyond its last draw.
          // Retire it only after those owners release it; never invalidate a
          // shader's resources merely because it has been idle for 120 frames.
          t.texture.destroy(true);
          borrowed.delete(k);
        }
      renderer.resetState();
      // AwayFL tests masks with stencil writes disabled. Pixi's stencil pipe
      // assumes the default write mask and clear value; resetState() does not
      // restore either. Establish them before clearing or drawing Pixi masks.
      // The caller restores AwayFL's GL state after this render.
      gl.stencilMask(0xff);
      gl.clearStencil(0);
      gl.disable(gl.STENCIL_TEST);
      try {
        renderer.render({ container: scene });
      } finally {
        // Advanced blends borrow pooled filter targets. The global bind group
        // outlives those targets, so release its inputs after composition.
        const bindings = renderer.filter._globalFilterBindGroup;
        if (bindings.resources[1]) {
          bindings.setResource(Texture.EMPTY.source, 1);
          bindings.setResource(Texture.EMPTY.source.style, 2);
          bindings.setResource(Texture.EMPTY.source, 3);
        }
      }
    },
    stats() {
      return {
        commands: records.size,
        sourceMeshes: sourceRecords.size,
        textures: borrowed.size,
        programs: programs.size,
      };
    },
    destroy() {
      for (const r of records.values()) r.destroy();
      records.clear();
      for (const r of sourceRecords.values()) r.destroy();
      sourceRecords.clear();
      scene.destroy();
      // Pixi normally relies on losing its context to release these samplers.
      // This context stays alive for AwayFL, so release only Pixi's samplers.
      for (const sampler of Object.values(renderer.texture._glSamplers))
        gl.deleteSampler(sampler);
      // Release renderer-owned batch bind groups before their borrowed sources.
      renderer.filter._globalFilterBindGroup.destroy();
      renderer.destroy(false);
      for (const t of borrowed.values()) t.texture.destroy(true);
      borrowed.clear();
    },
  };
}
