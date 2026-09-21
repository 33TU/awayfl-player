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
import "pixi.js/advanced-blend-modes";

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
    const key = g.vertex + g.fragment + g.offscreen;
    if (!shaderIds.has(key)) shaderIds.set(key, ++nextId);
    return [
      Object.entries(g.attributes)
        .map(([n, a]) => n + ":" + a.size + ":" + a.data.length)
        .join(","),
      shaderIds.get(key),
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
      for (const [k, t] of borrowed)
        if (epoch - t.epoch > 120) {
          t.texture.destroy(true);
          borrowed.delete(k);
        }
      renderer.resetState();
      renderer.render({ container: scene });
    },
    stats() {
      return {
        commands: records.size,
        textures: borrowed.size,
        programs: programs.size,
      };
    },
    destroy() {
      for (const r of records.values()) r.destroy();
      records.clear();
      scene.destroy();
      for (const t of borrowed.values()) t.texture.destroy(true);
      borrowed.clear();
      // Pixi normally relies on losing its context to release these samplers.
      // This context stays alive for AwayFL, so release only Pixi's samplers.
      for (const sampler of Object.values(renderer.texture._glSamplers))
        gl.deleteSampler(sampler);
      renderer.destroy(false);
    },
  };
}
