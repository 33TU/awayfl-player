import {
  Geometry,
  Buffer,
  BufferUsage,
  Mesh,
  Shader,
  GlProgram,
  UniformGroup,
} from "pixi.js";
import { saveGL } from "./shared-gl.mjs";

// Keep AwayFL's Flash filter scheduling/padding, but submit the blur and shadow
// GPU passes through Pixi. Reusing the task's shader equations also preserves
// inner/knockout/hideObject semantics that stock Pixi GlowFilter doesn't share.
export function createFilterPasses(stage, live, transport) {
  const gl = stage.context._gl;
  const passes = new Map();
  const textures = new WeakMap();
  const stats = { blur: 0, shadow: 0, unsupported: 0 };
  const positions = new Float32Array([
    0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1,
  ]);
  function native(image) {
    return stage.abstractions.getAbstraction(image).getTexture();
  }
  function texture(t) {
    // Filter tasks use the default AwayFL nearest/clamp sampler, independently
    // of the sampling state last used to draw this image as a scene material.
    let descriptor = textures.get(t._glTexture);
    if (!descriptor) {
      descriptor = {
        handle: t._glTexture,
        scaleMode: "nearest",
        addressMode: "clamp-to-edge",
      };
      textures.set(t._glTexture, descriptor);
    }
    descriptor.width = t.width ?? t._width;
    descriptor.height = t.height ?? t._height;
    return live.texture(descriptor);
  }
  function create(task, shadow) {
    const attributes = {
      [shadow ? "aPos" : "va0"]: {
        buffer: new Buffer({ data: positions, usage: BufferUsage.VERTEX }),
        format: "float32x4",
      },
    };
    const values = {
      uTexMatrix: { type: "vec4<f32>", size: 2, value: new Float32Array(8) },
    };
    if (shadow) {
      values.uPosMatrix = { type: "vec4<f32>", value: new Float32Array(4) };
      values.uFlashColor = { type: "vec4<f32>", value: new Float32Array(4) };
      values.uProps = { type: "vec4<f32>", value: new Float32Array(4) };
      values.uDir = { type: "vec2<f32>", value: new Float32Array(2) };
    } else values.uBlurData = { type: "vec3<f32>", value: new Float32Array(3) };
    const uniforms = new UniformGroup(values);
    const source = texture(native(task.source)).source;
    const shader = new Shader({
      glProgram: GlProgram.from({
        vertex: task.getVertexCode(),
        // Pixi Mesh reserves uColor for its own colour/alpha uniform.
        fragment: task.getFragmentCode().replace(/\buColor\b/g, "uFlashColor"),
      }),
      resources: shadow
        ? { uniforms, uBlur: source, uSource: source }
        : { uniforms, fs0: source },
    });
    const geometry = new Geometry({ attributes, topology: "triangle-list" });
    const mesh = new Mesh({ geometry, shader });
    // A filter pass replaces pixels; source-over would accumulate stale data.
    mesh.state.blend = false;
    return { uniforms, shader, geometry, mesh };
  }
  return {
    stats,
    draw(task) {
      const shadow = task.name === "DropShadowTask";
      const blur = task.name?.startsWith("FilterBlurTask:");
      if (!shadow && !blur) return false;
      // The task caller owns clearing/scissoring. Quad geometry covers destRect;
      // only ordinary single-sample images are supported by this bridge.
      const target = native(task.target);
      if (target._renderTarget?.isMsaaTarget) {
        stats.unsupported++;
        return false;
      }
      const restore = saveGL(gl);
      transport.suspend();
      try {
        const input = native(task.source);
        input._renderTarget?.present();
        const main = shadow ? native(task.sourceImage) : null;
        main?._renderTarget?.present();
        task.computeVertexData();
        const key = task.name;
        let pass = passes.get(key);
        if (!pass) passes.set(key, (pass = create(task, shadow)));
        const u = pass.uniforms.uniforms;
        if (shadow) {
          u.uPosMatrix.set(task.posMatrix);
          u.uTexMatrix.set(task.uvMatrices[0]);
          u.uTexMatrix.set(
            [
              0,
              0,
              task.inputRect.width / task.sourceImage.width,
              task.inputRect.height / task.sourceImage.height,
            ],
            4,
          );
          u.uFlashColor.set(task._uColor);
          u.uProps.set(task._uProps);
          const angle = (task.angle * Math.PI) / 180;
          u.uDir.set([
            (-Math.cos(angle) * task.distance * task.imageScale) /
              task.source.width,
            (-Math.sin(angle) * task.distance * task.imageScale) /
              task.source.height,
          ]);
          pass.shader.resources.uBlur = texture(input).source;
          pass.shader.resources.uSource = texture(main).source;
        } else {
          u.uTexMatrix.set(task._vertexConstantData);
          // preActivate has already set the scaled kernel step for this pass.
          u.uBlurData.set(task._data);
          pass.shader.resources.fs0 = texture(input).source;
        }
        pass.uniforms.update();
        live.renderer.resetState();
        live.renderer.render({
          container: pass.mesh,
          target: texture(target),
          clear: false,
        });
        stats[shadow ? "shadow" : "blur"]++;
        return true;
      } finally {
        restore();
        transport.resume();
      }
    },
    destroy() {
      for (const p of passes.values()) {
        p.mesh.destroy();
        p.geometry.destroy(true);
        p.shader.destroy();
      }
      passes.clear();
    },
  };
}
