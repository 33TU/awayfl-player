import assert from "node:assert/strict";
import { installIdleHover } from "./idle-hover.mjs";
import { createRenderProfiler } from "./render-profile.mjs";

let time = 0, calls = 0;
const mouse = { isMouse: true, screenX: 10, screenY: 20, queuedEvents: [], sourceEvent: {} };
const picker = {};
const manager = { _pointerDataArray: { 0: mouse }, _updateDirty: false,
  fireMouseEvents(p, ...args) {
    assert.equal(this, manager); calls++;
    mouse.queuedEvents.length = 0; this._updateDirty = false;
    return args[0] || "checked";
  } };
const original = manager.fireMouseEvents;
const player = { _mouseManager: manager, _mousePicker: picker, _view: { width: 100, height: 100 } };
const stats = { hoverChecks: 0, hoverSkips: 0, renderSize: [100, 100] };
for (const hz of [0, -1, NaN, Infinity]) {
  assert.equal(installIdleHover(player, stats, hz), undefined);
  assert.equal(manager.fireMouseEvents, original);
}
const restore = installIdleHover(player, stats, 12, () => time);
assert.equal(manager.fireMouseEvents(picker, "return-value"), "return-value");
time = 40; manager.fireMouseEvents(picker); assert.equal(calls, 1);
time = 84; manager.fireMouseEvents(picker); assert.equal(calls, 2);
time = 90;
// Every queued event bypasses the idle limit, including repeated clicks at the
// same coordinates, wheel, enter/leave and drag release outside the target.
for (const type of ["mousemove", "mousedown", "mouseup", "mousewheel", "mouseover", "mouseout", "dblclick"]) {
  mouse.queuedEvents.push({ type });
  const before = calls; manager.fireMouseEvents(picker);
  assert.equal(calls, before + 1, type); assert.equal(mouse.queuedEvents.length, 0);
}
function bypass(set, clear) {
  set(); const before = calls; manager.fireMouseEvents(picker);
  assert.equal(calls, before + 1); clear();
}
bypass(() => manager._updateDirty = true, () => {});
bypass(() => mouse.dragCollision = {}, () => mouse.dragCollision = null);
bypass(() => picker.dragNode = {}, () => picker.dragNode = null);
bypass(() => manager._isAVM1Dragging = true, () => manager._isAVM1Dragging = false);
bypass(() => mouse.sourceEvent.buttons = 1, () => mouse.sourceEvent.buttons = 0);
bypass(() => mouse.isMouse = false, () => mouse.isMouse = true);
bypass(() => manager._pointerDataArray[3] = {}, () => delete manager._pointerDataArray[3]);
bypass(() => mouse.screenX++, () => {});
bypass(() => player._view.width++, () => {});
let before = calls; manager.fireMouseEvents({}); manager.fireMouseEvents();
assert.equal(calls, before + 2, "other picker paths bypass the limit");
before = calls; manager.fireMouseEvents(picker); assert.equal(calls, before);
assert.ok(stats.hoverSkips >= 2);
// Profiling temporarily wraps this wrapper and must restore it on completion.
const gl = { getExtension: () => null, isContextLost: () => false,
  drawElements(){}, drawArrays(){}, drawElementsInstanced(){}, drawArraysInstanced(){},
  bufferData(){}, bufferSubData(){}, blitFramebuffer(){} };
const renderer = { gl, render(){}, renderGroup: { _buildInstructions(){}, _updateRenderGroups(){} },
  renderPipes: { batch: { upload(){}, execute(){} } } };
player.showNextFrame = () => { manager.fireMouseEvents(picker); player._renderer.render(); };
player._renderer = { render: () => renderer.render() };
const wrapped = manager.fireMouseEvents;
const profiler = createRenderProfiler(renderer, stats, undefined, player);
const pending = profiler.sample(1); player.showNextFrame(); time+=100; player.showNextFrame(); const report = await pending;
assert.equal(report.hover.hz, 12); assert.equal(report.hover.skips, 1); assert.equal(report.hover.checks, 0);
assert.equal(manager.fireMouseEvents, wrapped);
restore(); assert.equal(manager.fireMouseEvents, original); assert.equal(stats.idleHoverHz, 0);
let revision = 1;
const restoreRetained = installIdleHover(player, stats, 0, () => time, () => revision);
assert.equal(stats.retainedHover, true);
before = calls; manager.fireMouseEvents(picker); assert.equal(calls, before + 1);
time += 1000; manager.fireMouseEvents(picker);
assert.equal(calls, before + 1, "unchanged scene skips hover regardless of elapsed time");
revision++;
manager.fireMouseEvents(picker);
assert.equal(calls, before + 2, "a changed Pixi scene refreshes hover");
mouse.queuedEvents.push({ type: "mousedown" });
manager.fireMouseEvents(picker);
assert.equal(calls, before + 3, "a button press gets a fresh native pick");
restoreRetained();
assert.equal(stats.retainedHover, false);
// Restoration does not overwrite another component's later hook.
const undo = installIdleHover(player, stats, 12, () => time), external = () => {};
manager.fireMouseEvents = external; undo(); assert.equal(manager.fireMouseEvents, external);
console.log("Idle hover cadence, retained-scene skip, immediate input/drag/touch, resize, profiler and restoration passed.");
