import { createFilterPasses } from "./filter-passes.mjs";
import { createDirectScene } from "./direct-scene.mjs";
import { captureFrame } from "./capture.mjs";
import { saveGL, createTransport, mirrorGL } from "./shared-gl.mjs";
import { createLiveRenderer } from "./live-renderer.mjs";

export async function startLive(
  player,
  {
    onStatus = () => {},
    prepareOnly = true,
    directScene = true,
    pixiFilters = true,
    cachedLayers = true,
    validateGL = false,
    batching = true,
  } = {},
) {
  const root = player._renderer,
    gl = player._view.stage.context._gl;
  if (!gl?.getBufferSubData)
    throw Error("Live Pixi currently requires WebGL 2.");
  const wasPaused = player.isPaused;
  player.isPaused = true;
  const restore = saveGL(gl);
  let live;
  try {
    live = await createLiveRenderer(gl, { batching });
  } finally {
    restore();
    player.isPaused = wasPaused;
  }
  const unmirror = mirrorGL(gl, player._view.stage.context),
    transport = createTransport(gl),
    programs = new Map(),
    original = root.render,
    direct = prepareOnly && directScene ? createDirectScene() : null;
  const filters = pixiFilters
    ? createFilterPasses(player._view.stage, live, transport)
    : null;
  let stopped = false,
    inFrame = false,
    frames = 0,
    lastStatus = 0;
  const stats = {
    active: true,
    mode: direct
      ? "direct-scene"
      : prepareOnly
        ? "pixi-composition"
        : "double-render-reference",
    frames: 0,
    captureMs: 0,
    pixiMs: 0,
    renderSize: [gl.drawingBufferWidth, gl.drawingBufferHeight],
    lastError: null,
    transport: transport.stats,
    filters: filters?.stats,
    direct: direct?.stats,
  };
  function stop() {
    if (stopped) return;
    stopped = true;
    stats.active = false;
    root.render = original;
    const restore = saveGL(gl);
    try {
      transport.suspend();
      direct?.destroy();
      filters?.destroy();
      live.destroy();
      transport.destroy();
    } finally {
      restore();
      unmirror();
    }
    onStatus("AwayFL renderer active", stats);
  }
  root.render = function (...args) {
    if (inFrame || stopped) return original.apply(this, args);
    inFrame = true;
    try {
      const begin = performance.now();
      transport.begin();
      live.begin();
      const frame = captureFrame(player, {
        transport,
        programs,
        quiet: true,
        prepareOnly,
        // Validate initial setup, but avoid a synchronous GPU error query at
        // the preparation/composition boundary on every production frame.
        checkErrors: validateGL || frames === 0,
        direct,
        filters,
        drawSources:
          cachedLayers && direct
            ? (entries) => {
                // The encoder binds this batch's shader samplers from unit 0;
                // it does not run Pixi's scene/batch/filter render pipes.
                let textureUnits = 0;
                for (const { recipe } of entries)
                  textureUnits = Math.max(
                    textureUnits,
                    Object.keys(recipe.samplers).length,
                  );
                const restore = saveGL(gl, textureUnits);
                transport.suspend();
                try {
                  live.drawSources(entries);
                } finally {
                  restore();
                  transport.resume();
                }
              }
            : null,
        render: () => original.apply(this, args),
      });
      stats.preparation = frame.stats;
      stats.renderSize[0] = frame.width;
      stats.renderSize[1] = frame.height;
      stats.captureMs = performance.now() - begin;
      transport.suspend();
      const restore = saveGL(gl),
        start = performance.now();
      try {
        live.render(frame);
      } finally {
        restore();
      }
      stats.pixiMs = performance.now() - start;
      stats.frames = ++frames;
      stats.scene = live.stats();
      transport.sweep();
      if (performance.now() - lastStatus > 1000) {
        lastStatus = performance.now();
        onStatus("Live Pixi — experimental", stats);
      }
    } catch (error) {
      console.error("[Pixi live]", error);
      stats.lastError = error.message;
      // A capture can throw before an AwayFL draw reaches its deferred VAO
      // unbind. Reset that state before fallback material activation can clear
      // attributes on the interrupted mesh's VAO.
      player._view.stage.context._vaoContext?.unbindVertexArrays();
      stop();
      original.apply(this, args);
      onStatus("Pixi stopped: " + error.message, stats);
    } finally {
      inFrame = false;
    }
  };
  onStatus("Live Pixi — experimental", stats);
  return {
    stop,
    stats,
    get active() {
      return !stopped;
    },
  };
}
