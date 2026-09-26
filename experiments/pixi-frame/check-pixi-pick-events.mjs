import assert from "node:assert/strict";
import "pixi.js/events";
import { Container, Graphics, Mesh, MeshGeometry, Texture } from "pixi.js";
import { installPixiPickEvents, meshContainsPoint } from "./pixi-pick-events.mjs";

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
    if (!traverser) continue;
    // A masked entity is only a hit when its mask's picker is traversed too.
    let clipped = false;
    for (let p = container; p && !clipped; p = p.parent)
      if (p.mask && !this.getTraverser({ container: p.mask })) clipped = true;
    if (clipped) continue;
    if (hits.has(container)) return { rootNode: container };
  }
  return null;
};
const originalView = picker.getViewCollision;
const originalTraverser = prototype.getTraverser;
const player = { root: flashRoot, _mousePicker: picker, _mouseManager: { _pointerDataArray: {} } };
const stats = { configuration: {} };
const hitStateOwners = new Set();
const restore = installPixiPickEvents(player, scene, records, owners, { width: 100, height: 100 }, stats, { hitStates: () => hitStateOwners });
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
// An invisible hit state above the Pixi candidate (a walkable-area button)
// must win without a full-tree fallback.
const flashMapBranch = { parent: flashRoot };
const flashButton = { parent: flashMapBranch, pickObject: {} };
hitStateOwners.add(flashButton);
candidates = [flashButton, flashCached];
hits = new Set([flashButton, flashCached]);
visited.length = 0;
const fallbacksBefore = stats.pixiEventFallbacks;
assert.equal(picker.getViewCollision(210, 10).rootNode, flashButton, "hit-state owner beats the visible candidate");
assert.deepEqual(visited, [flashButton]);
assert.equal(stats.pixiEventFallbacks, fallbacksBefore, "no fallback needed");
hitStateOwners.clear();
// A full-stage mask at the top of the tree is never a Pixi target: the hit
// goes to the content beneath it, with the hit-state owner still admitted.
const flashMaskOwner = { parent: flashRoot };
const stageMask = new Graphics().rect(0, 0, 400, 100).fill(0xffffff);
stageMask.eventMode = "static";
scene.addChild(stageMask);
scene.mask = stageMask;
owners.set(stageMask, flashMaskOwner);
records.set(flashMaskOwner, {});
candidates = [flashMaskOwner, flashCached];
hits = new Set([flashCached]);
visited.length = 0;
assert.equal(picker.getViewCollision(210, 10).rootNode, flashCached, "a mask above the content is skipped by the Pixi hit test");
assert.deepEqual(visited, [flashCached], "the mask's own scope is never tried");
scene.mask = null;
stageMask.removeFromParent();
// A letterbox frame (a mesh with a hole) on top of everything must not claim
// the hole: Pixi's own Mesh.containsPoint does, by walking triangle lists
// one index at a time.
const frameGeometry = new MeshGeometry({
  positions: new Float32Array([0, 0, 400, 0, 400, 100, 0, 100, 200, 0, 220, 0, 220, 20, 200, 20]),
  uvs: new Float32Array(16),
  indices: new Uint32Array([0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]),
});
const frame = new Mesh({ geometry: frameGeometry, texture: Texture.WHITE });
frame.eventMode = "static";
scene.addChild(frame);
const flashFrame = { parent: flashRoot };
owners.set(frame, flashFrame);
records.set(flashFrame, {});
assert.equal(meshContainsPoint(frame, 210, 10), false, "the hole is not inside the frame");
assert.equal(meshContainsPoint(frame, 100, 10), true, "the frame's own bars still hit");
assert.equal(meshContainsPoint(frame, 205, 5), false, "a corner of the hole is not inside the frame");
candidates = [flashFrame, flashCached];
hits = new Set([flashFrame, flashCached]);
visited.length = 0;
assert.equal(picker.getViewCollision(210, 10).rootNode, flashCached, "a hit inside the frame's hole goes to the content beneath");
assert.deepEqual(visited, [flashCached]);
frame.removeFromParent();
// Content clipped by a Flash mask: Pixi asks whether the mask contains the
// point through the masked wrapper's effect, and the mask is a plain record
// container holding the mask art, not a Graphics. The clipped art overlaps
// the cached leaf at x 200..220; only x 150..170 stays inside the mask.
const maskRecord = new Container();
maskRecord.addChild(new Graphics().rect(150, 0, 20, 20).fill(0xffffff));
const wrapper = new Container();
const masked = new Graphics().rect(150, 0, 80, 40).fill(0x123456);
masked.eventMode = "static";
wrapper.addChild(masked);
wrapper.mask = maskRecord;
const maskedBranch = new Container();
maskedBranch.addChild(maskRecord, wrapper);
scene.addChild(maskedBranch);
const flashMasked = { parent: flashRoot };
owners.set(masked, flashMasked);
records.set(flashMasked, {});
candidates = [flashMasked, flashCached];
hits = new Set([flashMasked, flashCached]);
visited.length = 0;
assert.equal(picker.getViewCollision(160, 10).rootNode, flashMasked, "a hit inside the mask reaches the clipped content");
assert.deepEqual(visited, [flashMasked]);
visited.length = 0;
assert.equal(picker.getViewCollision(210, 10).rootNode, flashCached, "clipped content outside its mask is not a candidate");
assert.deepEqual(visited, [flashCached], "no fallback: the leaf beneath is the Pixi candidate");
wrapper.mask = null;
maskedBranch.removeFromParent();
// The native pick accepts clipped content only through its mask's picker;
// the mask is a sibling of the clipped branch, outside the candidate's
// ancestor path, and must still be traversed by the scoped pick.
const flashListFrame = { parent: flashRoot };
const flashListMask = { parent: flashListFrame };
const flashList = { parent: flashListFrame, mask: flashListMask };
const flashRow = { parent: flashList };
const rowArt = new Graphics().rect(300, 0, 20, 20).fill(0x00ffff);
rowArt.eventMode = "static";
scene.addChild(rowArt);
owners.set(rowArt, flashRow);
records.set(flashRow, {});
candidates = [flashRow, flashButton];
hits = new Set([flashRow, flashButton]);
hitStateOwners.add(flashButton);
visited.length = 0;
assert.equal(picker.getViewCollision(310, 10).rootNode, flashRow, "clipped content stays pickable when its mask is a sibling");
assert.deepEqual(visited, [flashRow, flashListMask], "the mask is traversed inside the row's scope");
hitStateOwners.clear();
rowArt.removeFromParent();
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
