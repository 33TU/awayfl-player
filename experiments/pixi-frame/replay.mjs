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
  BufferImageSource,
  Sprite,
  Rectangle,
} from "pixi.js";
import "./flash-blends.mjs";
const uniformTypes = {
  5126: "f32",
  5124: "i32",
  35664: "vec2<f32>",
  35665: "vec3<f32>",
  35666: "vec4<f32>",
  35674: "mat2x2<f32>",
  35675: "mat3x3<f32>",
  35676: "mat4x4<f32>",
};
export async function buildReplay(frame, canvas) {
  const renderer = new WebGLRenderer();
  await renderer.init({
    canvas,
    width: frame.width,
    height: frame.height,
    resolution: 1,
    antialias: true,
    backgroundColor: 0,
    backgroundAlpha: 1,
    useBackBuffer: true,
    preserveDrawingBuffer: true,
    preference: "webgl",
    preferWebGLVersion: 2,
  });
  const scene = new Container(),
    textures = new Map(),
    programs = new Map(),
    resources = [],
    crops = [];
  function texture(t) {
    if (textures.has(t)) return textures.get(t);
    const source = new BufferImageSource({
      resource: t.pixels,
      width: t.width,
      height: t.height,
      format: "rgba8unorm",
      alphaMode: "premultiplied-alpha",
      scaleMode: t.scaleMode || "nearest",
      addressMode: t.addressMode || "clamp-to-edge",
    });
    const out = new Texture({ source });
    textures.set(t, out);
    return out;
  }
  function mesh(g) {
    const attributes = {};
    for (const [name, a] of Object.entries(g.attributes)) {
      const buffer = new Buffer({ data: a.data, usage: BufferUsage.VERTEX });
      attributes[name] = {
        buffer,
        format: "float32" + (a.size > 1 ? "x" + a.size : ""),
        stride: a.size * 4,
      };
    }
    // Keep the original tessellation and material shader, substituting only
    // the final clip-to-screen transform for Pixi's render-target transform.
    let vertex = g.vertex.replace(/void\s+main\s*\(/, "void awayMain(");
    vertex += `\nuniform mat3 uProjectionMatrix;\nuniform mat3 uWorldTransformMatrix;\nuniform mat3 uTransformMatrix;\nuniform vec4 uAwayViewport;\nvoid main(){awayMain();vec2 p=gl_Position.xy/gl_Position.w; p=p*vec2(0.5,${g.offscreen ? "0.5" : "-0.5"})+0.5;p=p*uAwayViewport.zw+uAwayViewport.xy;gl_Position=vec4((uProjectionMatrix*uWorldTransformMatrix*uTransformMatrix*vec3(p,1.0)).xy,0.0,1.0);}\n`;
    const key = vertex + g.fragment;
    let program = programs.get(key);
    if (!program) {
      program = GlProgram.from({ vertex, fragment: g.fragment });
      programs.set(key, program);
    }
    const values = {
      uAwayViewport: {
        type: "vec4<f32>",
        value: new Float32Array([
          g.viewport.x,
          g.viewport.y,
          g.viewport.width,
          g.viewport.height,
        ]),
      },
    };
    for (const [name, u] of Object.entries(g.uniforms)) {
      const type = uniformTypes[u.type];
      if (!type) throw Error("Unsupported shader uniform type " + u.type);
      values[name] = {
        type,
        value:
          Array.isArray(u.value) || ArrayBuffer.isView(u.value)
            ? new Float32Array(u.value)
            : u.value,
        size: u.size,
      };
    }
    const shaderResources = { captured: new UniformGroup(values) };
    for (const [name, t] of Object.entries(g.samplers))
      shaderResources[name] = texture(t).source;
    const shader = new Shader({
      glProgram: program,
      resources: shaderResources,
    });
    const geometry = new Geometry({ attributes, topology: "triangle-list" });
    // Bounds are conservative screen rectangles; no geometry is discarded.
    Object.assign(geometry._bounds, {
      minX: g.bounds?.x ?? g.viewport.x,
      minY: g.bounds?.y ?? g.viewport.y,
      maxX:
        (g.bounds?.x ?? g.viewport.x) + (g.bounds?.width ?? g.viewport.width),
      maxY:
        (g.bounds?.y ?? g.viewport.y) + (g.bounds?.height ?? g.viewport.height),
    });
    geometry._boundsDirty = false;
    const result = new Mesh({ geometry, shader });
    result.blendMode = g.blend;
    resources.push(geometry, shader);
    return result;
  }
  function destroy() {
    scene.destroy({ children: true });
    for (const r of resources)
      r instanceof Geometry ? r.destroy(true) : r.destroy();
    for (const t of crops) t.destroy();
    for (const t of textures.values()) t.destroy(true);
    renderer.destroy();
  }
  try {
    for (const command of frame.commands) {
      const group = new Container();
      if (command.kind === "cache") {
        const full = texture(command.pixels);
        const cropped = new Texture({
          source: full.source,
          frame: new Rectangle(
            0,
            0,
            command.bounds.width,
            command.bounds.height,
          ),
        });
        crops.push(cropped);
        const sprite = new Sprite(cropped);
        sprite.position.set(command.bounds.x, command.bounds.y);
        sprite.width = command.bounds.width;
        sprite.height = command.bounds.height;
        group.addChild(sprite);
        group.blendMode = command.blend === "layer" ? "normal" : command.blend;
      } else for (const g of command.geometry) group.addChild(mesh(g));
      let wrapped = group;
      for (const geometry of command.masks) {
        const outer = new Container(),
          mask = new Container();
        for (const g of geometry) mask.addChild(mesh(g));
        outer.addChild(wrapped, mask);
        wrapped.mask = mask;
        wrapped = outer;
      }
      scene.addChild(wrapped);
    }
    return {
      renderer,
      scene,
      render: () => renderer.render({ container: scene }),
      destroy,
    };
  } catch (error) {
    destroy();
    throw error;
  }
}
