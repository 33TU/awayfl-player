// Shared-context mask and resource ownership regressions. No game login needed.
import { GlProgram, Shader, Texture } from "pixi.js";
import { createLiveRenderer } from "./live-renderer.mjs";
import { saveGL } from "./shared-gl.mjs";

export async function checkRenderer(player) {
  const gl = player._view.stage.context._gl;
  const paused = player.isPaused;
  player.isPaused = true;
  const restore = saveGL(gl);
  const live = await createLiveRenderer(gl);
  const width = gl.drawingBufferWidth,
    height = gl.drawingBufferHeight;
  const viewport = { x: 0, y: 0, width, height };
  const vertex = `attribute vec2 aPosition;
    void main(){gl_Position=vec4(aPosition,0.0,1.0);}`;
  const fragment = `uniform vec4 uFill; void main(){gl_FragColor=uFill;}`;
  function rect(x, y, w, h, color) {
    const x0 = (x / width) * 2 - 1,
      x1 = ((x + w) / width) * 2 - 1;
    const y0 = 1 - (y / height) * 2,
      y1 = 1 - ((y + h) / height) * 2;
    return {
      vertex,
      fragment,
      viewport,
      bounds: { x, y, width: w, height: h },
      attributes: {
        aPosition: {
          size: 2,
          data: new Float32Array([
            x0,
            y0,
            x1,
            y0,
            x1,
            y1,
            x0,
            y0,
            x1,
            y1,
            x0,
            y1,
          ]),
        },
      },
      uniforms: { uFill: { type: gl.FLOAT_VEC4, size: 1, value: color } },
      samplers: {},
      blend: "normal",
      offscreen: false,
    };
  }
  const mask = rect(20, 20, 80, 80, [1, 1, 1, 1]);
  const nested = rect(40, 40, 40, 40, [1, 1, 1, 1]);
  const frame = {
    width,
    height,
    commands: [
      {
        key: "background",
        kind: "mesh",
        geometry: [rect(0, 0, width, height, [0.2, 0.2, 0.2, 1])],
        masks: [],
      },
      {
        key: "masked",
        kind: "mesh",
        geometry: [rect(0, 0, 140, 140, [1, 0, 0, 1])],
        masks: [[mask]],
      },
      {
        key: "nested",
        kind: "mesh",
        geometry: [rect(0, 0, 140, 140, [0, 1, 0, 1])],
        masks: [[mask], [nested]],
      },
      {
        key: "unmasked",
        kind: "mesh",
        geometry: [rect(120, 20, 20, 20, [0, 0, 1, 1])],
        masks: [],
      },
    ],
  };
  const empty = { width, height, commands: [] };
  const sample = (x, y) => {
    const bytes = new Uint8Array(4);
    gl.readPixels(x, height - y - 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return [...bytes];
  };
  let shader,
    handle,
    destroyed = false;
  try {
    const masks = [];
    for (let i = 0; i < 2; i++) {
      // Native masks leave writes disabled; also poison the clear value/test.
      gl.stencilMaskSeparate(gl.FRONT, 0);
      gl.stencilMaskSeparate(gl.BACK, 0);
      gl.clearStencil(7);
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl.NEVER, 7, 255);
      const restoreFrame = saveGL(gl);
      live.render(frame);
      const pixels = [
        sample(10, 10),
        sample(30, 30),
        sample(50, 50),
        sample(130, 30),
      ];
      restoreFrame();
      masks.push({
        pixels,
        writeMask: gl.getParameter(gl.STENCIL_WRITEMASK),
        backWriteMask: gl.getParameter(gl.STENCIL_BACK_WRITEMASK),
        clear: gl.getParameter(gl.STENCIL_CLEAR_VALUE),
        test: gl.isEnabled(gl.STENCIL_TEST),
      });
    }
    handle = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, handle);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      1,
      1,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255, 0, 0, 255]),
    );
    // Small encoder/filter passes only touch low sampler slots. Keep a high
    // slot active to verify both its binding and the active unit are preserved.
    const highUnit = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) - 1;
    for (const unit of [0, 1, highUnit]) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, handle);
    }
    const activeTexture = gl.activeTexture;
    let switches = 0;
    gl.activeTexture = function (...args) {
      switches++;
      return activeTexture.apply(this, args);
    };
    let restoreScoped;
    try {
      restoreScoped = saveGL(gl, 2);
    } finally {
      gl.activeTexture = activeTexture;
    }
    for (const unit of [0, 1]) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    restoreScoped();
    const scopedState = {
      switches,
      active: gl.getParameter(gl.ACTIVE_TEXTURE) === gl.TEXTURE0 + highUnit,
      highBinding: gl.getParameter(gl.TEXTURE_BINDING_2D) === handle,
      lowBindings: [0, 1].map((unit) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        return gl.getParameter(gl.TEXTURE_BINDING_2D) === handle;
      }),
    };
    const descriptor = {
      handle,
      width: 1,
      height: 1,
      scaleMode: "nearest",
      addressMode: "clamp-to-edge",
    };
    const texture = live.texture(descriptor),
      source = texture.source;
    shader = new Shader({
      glProgram: GlProgram.from({
        vertex,
        fragment: `uniform sampler2D uSource;void main(){gl_FragColor=texture2D(uSource,vec2(0.5));}`,
      }),
      resources: { uSource: texture.source },
    });
    for (let i = 0; i < 125; i++) live.render(empty);
    const retained = !source.destroyed && shader.resources.uSource === source;
    shader.resources.uSource = Texture.EMPTY.source;
    live.render(empty);
    const released = source.destroyed;
    // Stopping the bridge must release bindings before borrowed wrappers,
    // without deleting the AwayFL-owned WebGL texture.
    const rebound = live.texture(descriptor).source;
    live.render({
      width,
      height,
      commands: [
        {
          key: "sprite",
          kind: "cache",
          pixels: descriptor,
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          blend: "normal",
          masks: [],
        },
      ],
    });
    shader.destroy();
    shader = null;
    live.destroy();
    destroyed = true;
    return {
      masks,
      scopedState,
      retained,
      released,
      destroyedOnStop: rebound.destroyed,
      nativeTextureSurvives: gl.isTexture(handle),
      glError: gl.getError(),
    };
  } finally {
    shader?.destroy();
    if (!destroyed) live.destroy();
    gl.deleteTexture(handle);
    restore();
    player.isPaused = paused;
  }
}
