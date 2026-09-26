import assert from "node:assert/strict";
import "pixi.js/events";
import { Container, Graphics } from "pixi.js";
import { installPixiPickEvents } from "./pixi-pick-events.mjs";

const scene = new Container();
const flashRoot = { parent: null };
const flashA = { parent: flashRoot }, flashB = { parent: flashRoot };
const a = new Graphics().rect(0, 0, 40, 40).fill(0xff0000);
const b = new Graphics().rect(20, 0, 40, 40).fill(0x00ff00);
a.eventMode = b.eventMode = "static";
scene.addChild(a, b);
const records = new Map([[flashA, {}], [flashB, {}]]);
const owners = new WeakMap([[a, flashA], [b, flashB]]);
const visited = [];
let hits = new Set([flashA, flashB]);
let candidates = [flashA, flashB];
const prototype = {
  getTraverser(node) { visited.push(node.container); return node; },
};
const picker = Object.create(prototype);
picker.node = { view: { width: 100, height: 100 } };
picker.getViewCollision = function() {
  for (const container of candidates) {
    const traverser = this.getTraverser({ container });
    if (traverser && hits.has(container)) return { rootNode: container };
  }
  return null;
};
const originalView = picker.getViewCollision;
const originalTraverser = prototype.getTraverser;
const player = { root: flashRoot, _mousePicker: picker, _mouseManager: { _pointerDataArray: {} } };
const stats = { configuration: {} };
const restore = installPixiPickEvents(player, scene, records, owners, { width: 100, height: 100 }, stats);
assert.equal(picker.getViewCollision(30, 10).rootNode, flashB);
assert.deepEqual(visited, [flashB], "Pixi topmost target prunes other Flash branches");
visited.length = 0;
hits = new Set([flashA]);
assert.equal(picker.getViewCollision(30, 10).rootNode, flashA);
assert.deepEqual(visited, [flashB, flashA], "Flash-only hit retries the native tree");
visited.length = 0;
picker.dragNode = {};
picker.getViewCollision(30, 10);
assert.deepEqual(visited, [flashA], "dragging uses native picking");
picker.dragNode = null;
player._mouseManager._pointerDataArray[0] = {
  queuedEvents: [{ type: "mousedown" }], move: { type: "mousemove" }, dragCollision: null,
};
visited.length = 0;
picker.getViewCollision(30, 10);
assert.deepEqual(visited, [flashB, flashA], "button presses use the scoped pick and fall back to the native tree");
delete player._mouseManager._pointerDataArray[0];
const flashGroup = { parent: flashRoot };
const flashLeaf = { parent: flashGroup };
const flashSibling = { parent: flashGroup };
const leaf = new Graphics().rect(70, 0, 20, 20).fill(0x0000ff);
leaf.eventMode = "static";
scene.addChild(leaf);
owners.set(leaf, flashLeaf);
records.set(flashLeaf, {});
candidates = [flashSibling, flashLeaf];
hits = new Set([flashSibling]);
visited.length = 0;
assert.equal(picker.getViewCollision(80, 10).rootNode, flashSibling);
assert.deepEqual(visited, [flashLeaf, flashSibling], "a visual leaf can route to a sibling Flash hit area in its control after its own branch misses");
assert.equal(stats.pixiEventPicks, 4);
assert.equal(stats.pixiEventHits, 2);
assert.equal(stats.pixiEventFallbacks, 2);
// Content inside a render group cached as a texture never gets Pixi's
// transform update; the boundary must still find it through local transforms.
const cachedGroup = new Container();
cachedGroup.x = 200; cachedGroup.y = 0;
cachedGroup.cacheAsTexture(true);
const cachedLeaf = new Graphics().rect(0, 0, 20, 20).fill(0xff00ff);
cachedLeaf.eventMode = "static";
cachedGroup.addChild(cachedLeaf);
scene.addChild(cachedGroup);
const flashCached = { parent: flashRoot };
owners.set(cachedLeaf, flashCached);
records.set(flashCached, {});
candidates = [flashCached];
hits = new Set([flashCached]);
visited.length = 0;
assert.equal(picker.getViewCollision(210, 10).rootNode, flashCached, "hit inside a cached render group");
assert.deepEqual(visited, [flashCached]);
candidates = [flashSibling, flashLeaf];
hits = new Set([flashSibling]);
restore();
assert.equal(picker.getViewCollision, originalView);
assert.equal(prototype.getTraverser, originalTraverser);
assert.equal(stats.configuration.pixiEvents, false);
// Opt-in: presses keep the original full native pick.
const nativePressStats = { configuration: {} };
const restoreNativePress = installPixiPickEvents(player, scene, records, owners, { width: 100, height: 100 }, nativePressStats, { nativePress: true });
player._mouseManager._pointerDataArray[0] = {
  queuedEvents: [{ type: "mousedown" }], move: { type: "mousemove" }, dragCollision: null,
};
visited.length = 0;
picker.getViewCollision(30, 10);
assert.deepEqual(visited, [flashSibling], "nativePress keeps the full native pick for button presses");
delete player._mouseManager._pointerDataArray[0];
restoreNativePress();
assert.equal(picker.getViewCollision, originalView);
assert.equal(nativePressStats.configuration.pixiEventsNativePress, true);
console.log("Pixi event boundary picks the top branch, falls back for Flash-only hits, and preserves dragging.");
