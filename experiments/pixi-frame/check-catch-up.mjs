import assert from "node:assert/strict";
import { installCatchUp } from "./catch-up.mjs";

function fixture(workPerFrame = 1) {
  let clock = 0;
  const calls = [];
  const player = {
    frameRate: 24,
    isPaused: false,
    _time: 0,
    _currentFps: 0,
    _requestedRender: false,
    _trapResize: false,
    _avmHandler: { resizeStage: () => calls.push("resize") },
    _renderer: { render: () => calls.push("render") },
    showNextFrame(dt) {
      calls.push(["timeline", dt]);
      clock += workPerFrame;
      this._renderer.render();
    },
  };
  let nativeCalls = 0;
  function original(dt) {
    nativeCalls++;
    if (this._requestedRender) this._renderer.render();
    this._requestedRender = false;
    calls.push(["native", dt]);
  }
  const timer = { _callback: original, _callbackContext: player,
    setCallback(callback, context) { this._callback = callback; this._callbackContext = context; } };
  player._timer = timer;
  const stats = { configuration: {} };
  const restore = installCatchUp(player, stats, { now: () => clock });
  assert.equal(typeof restore, "function");
  return { player, timer, original, calls, stats, restore, get nativeCalls() { return nativeCalls; } };
}

{
  const f = fixture();
  f.player._trapResize = true;
  f.timer._callback.call(f.player, 100);
  assert.deepEqual(f.calls, ["resize", ["timeline", 41], ["timeline", 41], "render"]);
  assert.equal(f.player._time, 18);
  assert.equal(f.player._currentFps, 2);
  assert.equal(f.stats.catchUpSkippedRenders, 1);
  assert.equal(f.stats.catchUpExtraSteps, 1);
  f.player._requestedRender = true;
  f.timer._callback.call(f.player, 10);
  assert.equal(f.nativeCalls, 1);
  assert.equal(f.calls.filter(c => c === "render").length, 2);
  assert.equal(f.player._time, 28);
  f.restore();
  assert.equal(f.timer._callback, f.original);
  assert.equal(f.stats.configuration.catchUp, false);
}

{
  const f = fixture(40);
  f.timer._callback.call(f.player, 100);
  assert.equal(f.stats.catchUpLastSteps, 2);
  f.timer._callback.call(f.player, 100);
  assert.equal(f.stats.catchUpLastSteps, 1, "expensive work must suppress extra timeline steps");
  assert.equal(f.calls.filter(c => c === "render").length, 2);
  f.player.isPaused = true;
  f.timer._callback.call(f.player, 100);
  assert.equal(f.nativeCalls, 1, "paused callbacks use the native loop");
  f.restore();
}

{
  const f = fixture();
  const render = f.player._renderer.render;
  f.player.showNextFrame = () => { throw Error("timeline failure"); };
  assert.throws(() => f.timer._callback.call(f.player, 100), /timeline failure/);
  assert.equal(f.player._renderer.render, render, "render hook restored after a timeline exception");
  f.restore();
}

console.log("Bounded timeline catch-up and renderer restoration passed");
