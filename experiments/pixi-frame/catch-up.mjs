// AwayFL normally caps elapsed time to one SWF frame per RAF callback. When a
// callback arrives late but recent frames were cheap, advance a few timeline
// frames and present only the last one. Sustained expensive frames keep the
// original one-step behavior so they cannot start a catch-up spiral.
export function installCatchUp(player, stats, { maxSteps = 3, now = () => performance.now() } = {}) {
  const timer = player?._timer;
  const original = timer?._callback;
  const context = timer?._callbackContext;
  if (typeof original !== "function" || context !== player ||
      typeof timer.setCallback !== "function" ||
      typeof player.showNextFrame !== "function" || !player._renderer)
    return;

  maxSteps = Number.isInteger(maxSteps) ? Math.max(1, Math.min(4, maxSteps)) : 3;
  let recentWork = null;
  stats.configuration.catchUp = true;
  stats.catchUpCallbacks = 0;
  stats.catchUpExtraSteps = 0;
  stats.catchUpSkippedRenders = 0;
  stats.catchUpLastSteps = 0;
  stats.catchUpRecentWorkMs = null;

  function callback(dt) {
    const rate = player.frameRate;
    const step = Math.floor(1000 / rate);
    if (player.isPaused || !Number.isFinite(dt) || dt < 0 ||
        !Number.isFinite(step) || step <= 0 ||
        !Number.isFinite(player._time) || !player._avmHandler)
      return original.call(player, dt);

    const limit = recentWork === null || recentWork < step * 0.75
      ? maxSteps : 1;
    const elapsed = Math.min(dt, step * limit);
    player._time += elapsed;
    const due = Math.min(limit, Math.floor(player._time / step));
    if (!due) {
      stats.catchUpLastSteps = 0;
      // Preserve AwayFL's requested-render and resize behavior between ticks.
      return original.call(player, 0);
    }
    if (player._trapResize) {
      player._avmHandler.resizeStage();
      player._trapResize = false;
    }
    player._time -= due * step;
    stats.catchUpCallbacks++;
    stats.catchUpLastSteps = due;
    stats.catchUpExtraSteps += due - 1;
    const started = now();
    try {
      for (let i = 0; i < due; i++) {
        // Scripts, input and sounds still run in timeline order. Pixi synchronizes
        // and draws only the final state, avoiding repeat GPU work.
        if (i < due - 1) {
          const render = player._renderer.render;
          player._renderer.render = () => {};
          try { player.showNextFrame(step); }
          finally { player._renderer.render = render; }
          stats.catchUpSkippedRenders++;
        } else {
          player.showNextFrame(step);
        }
        player._currentFps++;
      }
      player._requestedRender = false;
    } finally {
      const work = now() - started;
      recentWork = recentWork === null ? work : recentWork * 0.75 + work * 0.25;
      stats.catchUpRecentWorkMs = recentWork;
    }
  }
  timer.setCallback(callback, player);
  return () => {
    if (timer._callback === callback) timer.setCallback(original, context);
    stats.configuration.catchUp = false;
  };
}
