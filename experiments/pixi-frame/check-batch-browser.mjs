import { createLiveRenderer } from "./live-renderer.mjs";
import { saveGL } from "./shared-gl.mjs";

// Actual WebGL draws: packed transforms, shared colors, mask/order boundaries,
// and retained geometry after a mesh moves or changes color.
export async function checkBatchRendering(player) {
  const gl = player._view.stage.context._gl,
    paused = player.isPaused;
  player.isPaused = true;
  const restore = saveGL(gl),
    width = gl.drawingBufferWidth,
    height = gl.drawingBufferHeight;
  let live;
  const vertex = `#version 300 es
precision highp float;
uniform vec4 vc[4];in vec4 va0;
vec4 transform(int n,vec4 v){return vec4(dot(v,vc[n+0]),dot(v,vc[n+1]),dot(v,vc[n+2]),dot(v,vc[n+3]));}
void main(){gl_Position=transform(0,va0);}`;
  const fragment = `#version 300 es
precision highp float;
uniform vec4 fc[1];out vec4 color;void main(){color=fc[0];}`;
  const data = new Float32Array([
    0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1,
  ]);
  function rect(key, x, y, w, h, color, masks = []) {
    return {
      key,
      kind: "geometry",
      masks,
      geometry: [
        {
          vertex,
          fragment,
          count: 6,
          blend: "normal",
          offscreen: false,
          viewport: { x: 0, y: 0, width, height },
          bounds: { x, y, width: w, height: h },
          attributes: { va0: { size: 4, data } },
          samplers: {},
          uniforms: {
            vc: {
              type: gl.FLOAT_VEC4,
              size: 4,
              value: new Float32Array([
                (w * 2) / width,
                0,
                0,
                (x * 2) / width - 1,
                0,
                (-h * 2) / height,
                0,
                1 - (y * 2) / height,
                0,
                0,
                1,
                0,
                0,
                0,
                0,
                1,
              ]),
            },
            fc: {
              type: gl.FLOAT_VEC4,
              size: 1,
              value: new Float32Array(color),
            },
          },
        },
      ],
    };
  }
  const mask = rect("mask", 25, 0, 10, 30, [1, 1, 1, 1]).geometry;
  const frame = {
    width,
    height,
    commands: [
      rect("red1", 0, 0, 20, 20, [1, 0, 0, 1]),
      rect("red2", 20, 0, 20, 20, [1, 0, 0, 1]),
      rect("red3", 40, 0, 20, 20, [1, 0, 0, 1]),
      rect("masked", 20, 0, 20, 20, [0, 1, 0, 1], [mask]),
      rect("blue", 35, 0, 10, 20, [0, 0, 1, 1]),
      rect("red4", 50, 0, 20, 20, [1, 0, 0, 1]),
    ],
  };
  const sample = () => {
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  };
  const reference = [];
  function edit() {
    frame.commands[1] = rect("red2", 20, 25, 20, 20, [1, 0, 0, 1]);
    frame.commands[4] = rect("blue", 35, 0, 10, 20, [0, 1, 1, 1]);
  }
  const original = [...frame.commands];
  try {
    live = await createLiveRenderer(gl, { batching: false });
    live.render(frame);
    reference.push(sample());
    edit();
    live.render(frame);
    reference.push(sample());
    live.destroy();
    live = null;
    frame.commands = [...original];
    live = await createLiveRenderer(gl, { batching: true });
    const results = [];
    for (let i = 0; i < 2; i++) {
      if (i) edit();
      live.render(frame);
      const pixels = sample();
      let max = 0;
      for (let j = 0; j < pixels.length; j++)
        max = Math.max(max, Math.abs(pixels[j] - reference[i][j]));
      results.push({ max, batching: live.stats().batching });
    }
    return { results, glError: gl.getError() };
  } finally {
    live?.destroy();
    restore();
    player.isPaused = paused;
  }
}
