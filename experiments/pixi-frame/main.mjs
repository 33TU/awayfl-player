import { loadBattleonFixture } from "./fixture.mjs";
import { captureFrame } from "./capture.mjs";
import { buildReplay } from "./replay.mjs";
const $ = (id) => document.getElementById(id),
  status = (text) => ($("status").textContent = text);
let frame, replay, player, wasPaused, report;
function getPlayer() {
  const p = $("player").contentWindow._AWAY_DEBUG_PLAYER_?.player;
  if (!p) throw Error("Wait for AwayFL to finish loading.");
  return p;
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function topDown(pixels, w, h) {
  const out = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < h; y++)
    out.set(pixels.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  return out;
}
function display(canvas, data, w, h) {
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").putImageData(new ImageData(data, w, h), 0, 0);
}
function compare(a, b, w, h) {
  let changed = 0,
    sum = 0,
    max = 0;
  const diff = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 3; c++) {
      const e = Math.abs(a[i + c] - b[i + c]);
      sum += e;
      max = Math.max(max, e);
      d = Math.max(d, e);
      diff[i + c] = Math.min(255, e * 4);
    }
    if (d > 3) changed++;
    diff[i + 3] = 255;
  }
  display($("difference"), topDown(diff, w, h), w, h);
  return {
    pixelsDifferingOver3Percent: +((changed * 100) / (w * h)).toFixed(3),
    meanChannelError: +(sum / (w * h * 3)).toFixed(3),
    maxChannelError: max,
    exact: sum === 0,
  };
}
async function fixture() {
  if (frame) await resume();
  status("Loading the local Battleon map fixture…");
  await loadBattleonFixture(getPlayer());
  status(
    "Battleon fixture ready. It contains map art and NPCs, without server players. Capture when ready.",
  );
  $("fixture").disabled = true;
}
async function capture() {
  if (frame) await resume();
  player = getPlayer();
  wasPaused = player.isPaused;
  player.isPaused = true;
  status("Capturing one frame and building Pixi geometry…");
  await delay(30);
  try {
    console.info("[Pixi] Capturing");
    frame = captureFrame(player);
    console.info("[Pixi] Captured", JSON.stringify(frame.stats));
    // Pixi destroys its WebGL context on disposal; use a fresh canvas for recapture.
    const canvas = $("pixi").cloneNode(false);
    $("pixi").replaceWith(canvas);
    replay = await buildReplay(frame, canvas);
    console.info("[Pixi] Rendering");
    replay.render();
    console.info("[Pixi] Reading pixels");
    const gl = replay.renderer.gl,
      actual = new Uint8Array(frame.width * frame.height * 4);
    gl.readPixels(
      0,
      0,
      frame.width,
      frame.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      actual,
    );
    display(
      $("reference"),
      topDown(frame.reference, frame.width, frame.height),
      frame.width,
      frame.height,
    );
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    report = {
      environment: {
        gpu: gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL || gl.RENDERER),
        devicePixelRatio,
        api: "WebGL 2",
      },
      resolution: [frame.width, frame.height],
      capture: frame.stats,
      pixelComparison: compare(
        frame.reference,
        actual,
        frame.width,
        frame.height,
      ),
      scope:
        "Frozen warm-cache rendering only; no ActionScript, animation or source-cache rebuild timing.",
      timings: null,
    };
    $("report").textContent = JSON.stringify(report, null, 2);
    $("measure").disabled = false;
    $("resume").disabled = false;
    status(
      report.pixelComparison.exact
        ? "Exact pixel match. Ready to measure."
        : "Replay ready; pixel differences are shown below. Timing alone does not establish a faster equivalent renderer.",
    );
    window.pixiExperiment = { frame, replay, report, measure, resume };
  } catch (e) {
    if (replay) {
      replay.destroy();
      replay = null;
    }
    frame = null;
    player.isPaused = wasPaused;
    throw e;
  }
}
async function measure() {
  if (!frame) throw Error("Capture a frame first.");
  status("Measuring render completion time (GPU synchronization included)…");
  async function sample(render, gl) {
    const values = [];
    let draws = 0;
    const methods = [
        "drawArrays",
        "drawElements",
        "drawArraysInstanced",
        "drawElementsInstanced",
      ],
      saved = {};
    for (const k of methods) {
      saved[k] = gl[k];
      gl[k] = function (...args) {
        draws++;
        return saved[k].apply(this, args);
      };
    }
    try {
      for (let i = 0; i < 12; i++) {
        await new Promise(requestAnimationFrame);
        const t = performance.now();
        draws = 0;
        render();
        gl.finish();
        if (i >= 2) values.push({ ms: performance.now() - t, draws });
      }
      const med = (k) =>
        values.map((v) => v[k]).sort((a, b) => a - b)[
          Math.floor(values.length / 2)
        ];
      return {
        medianRenderCompletionMs: +med("ms").toFixed(2),
        medianDrawCalls: med("draws"),
        samples: values.length,
      };
    } finally {
      Object.assign(gl, saved);
    }
  }
  const away = await sample(
      () => frame.renderer.render(),
      player._view.stage.context._gl,
    ),
    pixi = await sample(() => replay.render(), replay.renderer.gl);
  const checkedAway = new Uint8Array(frame.reference.length),
    checkedPixi = new Uint8Array(frame.reference.length);
  const ag = player._view.stage.context._gl,
    pg = replay.renderer.gl;
  frame.renderer.render();
  ag.readPixels(
    0,
    0,
    frame.width,
    frame.height,
    ag.RGBA,
    ag.UNSIGNED_BYTE,
    checkedAway,
  );
  replay.render();
  pg.readPixels(
    0,
    0,
    frame.width,
    frame.height,
    pg.RGBA,
    pg.UNSIGNED_BYTE,
    checkedPixi,
  );
  report.afterMeasurementPixelComparison = compare(
    checkedAway,
    checkedPixi,
    frame.width,
    frame.height,
  );
  report.timings = {
    away,
    pixi,
    comparable: report.pixelComparison.exact,
    note: "gl.finish is intentional here. These are isolated render completion times, not live game FPS. Pixel differences must be resolved before claiming equivalent rendering performance.",
  };
  $("report").textContent = JSON.stringify(report, null, 2);
  status("Measurement complete. AwayFL remains paused until Resume.");
  return report;
}
async function resume() {
  if (player) player.isPaused = wasPaused;
  if (replay) replay.destroy();
  replay = null;
  frame = null;
  $("measure").disabled = true;
  $("resume").disabled = true;
  status("AwayFL resumed.");
}
let busy = false,
  fixtureReady = false;
for (const [id, fn] of Object.entries({ fixture, capture, measure, resume }))
  $(id).onclick = async () => {
    if (busy) return;
    busy = true;
    for (const name of ["fixture", "capture", "measure", "resume"])
      $(name).disabled = true;
    try {
      await fn();
      if (id === "fixture") fixtureReady = true;
    } catch (e) {
      console.error(e);
      status(e.message);
      $("report").textContent = e.stack || String(e);
    } finally {
      busy = false;
      $("fixture").disabled = fixtureReady;
      $("capture").disabled = false;
      $("measure").disabled = !frame;
      $("resume").disabled = !frame;
    }
  };
window.pixiExperimentActions = { capture, fixture, measure, resume };
window.addEventListener("pagehide", () => {
  if (player) player.isPaused = wasPaused;
});
