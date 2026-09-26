import { EventBoundary } from "pixi.js";

// Pixi's Mesh.containsPoint walks an indexed triangle list one index at a
// time, so it also tests the triangles straddling consecutive real ones. A
// mesh with a gap (the letterbox frame around the stage, a ring, text with
// counters) then reports the gap as solid and swallows every hit beneath it.
const sign = (px, py, ax, ay, bx, by) => (px - bx) * (ay - by) - (ax - bx) * (py - by);
function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
export function meshContainsPoint(mesh, x, y) {
  const bounds = mesh.bounds;
  if (!bounds || !bounds.containsPoint(x, y)) return false;
  const geometry = mesh.geometry;
  const attribute = geometry.attributes?.aPosition;
  const vertices = geometry.getBuffer("aPosition").data;
  // Interleaved layouts keep positions at a stride; separate buffers use 2.
  const stride = attribute?.stride ? attribute.stride / 4 : 2;
  const offset = attribute?.offset ? attribute.offset / 4 : 0;
  const strip = geometry.topology === "triangle-strip";
  const step = strip ? 1 : 3;
  const index = geometry.getIndex()?.data;
  const count = index ? index.length : Math.floor((vertices.length - offset) / stride);
  const at = i => (index ? index[i] : i) * stride + offset;
  for (let i = 0; i + 2 < count; i += step) {
    const a = at(i), b = at(i + 1), c = at(i + 2);
    if (pointInTriangle(x, y, vertices[a], vertices[a + 1], vertices[b], vertices[b + 1],
        vertices[c], vertices[c + 1])) return true;
  }
  return false;
}

// Pixi owns the broad target choice; AwayFL still creates PickingCollision and
// dispatches Flash mouse events. Retry the full tree when a visual Pixi target
// does not correspond to a Flash hit (e.g. a button with a custom hit area).
export function installPixiPickEvents(player, scene, records, owners, renderer, stats, { nativePress = false, hitStates = null } = {}) {
  const picker = player?._mousePicker;
  const prototype = picker && Object.getPrototypeOf(picker);
  if (!prototype || typeof picker.getViewCollision !== "function" ||
      typeof prototype.getTraverser !== "function") return;
  const originalViewCollision = picker.getViewCollision;
  const originalGetTraverser = prototype.getTraverser;
  const boundary = new EventBoundary(scene);
  // Pixi skips the transform update of a render group cached as a texture, so
  // worldTransform inside a scenery-cached branch (the map) is stale or unset
  // and the default hit test misses it. Walk the local transform chain
  // instead, but carry the point down rather than matrices up: the point in a
  // container's space is cached per hit test, and a leaf only applies its own
  // local inverse to its parent's point. Building a world matrix per visited
  // leaf was a quarter of the hit test.
  const points = new WeakMap();
  let stamp = 0;
  const localPointOf = (container, location) => {
    let entry = points.get(container);
    if (entry && entry.stamp === stamp) return entry;
    if (!entry) points.set(container, entry = { x: 0, y: 0, stamp: 0 });
    const parentPoint = container.parent && container !== scene
      ? localPointOf(container.parent, location) : location;
    container.updateLocalTransform?.();
    container.localTransform.applyInverse(parentPoint, entry);
    entry.stamp = stamp;
    return entry;
  };
  const local = { x: 0, y: 0 };
  const leafPoint = (container, location) => {
    const parentPoint = container.parent && container !== scene
      ? localPointOf(container.parent, location) : location;
    container.updateLocalTransform?.();
    return container.localTransform.applyInverse(parentPoint, local);
  };
  const containsPoint = (container, location) => {
    if (container.hitArea) return true;
    if (container.containsPoint) {
      const p = leafPoint(container, location);
      if (container.renderPipeId === "mesh") return meshContainsPoint(container, p.x, p.y);
      return container.containsPoint(p);
    }
    // A Flash mask is a display object of its own: the boundary hands its
    // record's outer container to this test through the masked wrapper's
    // effect, so answer for the art inside it. A miss here prunes everything
    // the mask clips (the inventory list rows, for instance).
    for (const child of container.children)
      if (child.visible && containsPoint(child, location)) return true;
    return false;
  };
  boundary.hitTestFn = containsPoint;
  const prune = boundary.hitPruneFn;
  boundary.hitPruneFn = (container, location) => {
    // A Flash mask stays in the display list but is never drawn or picked;
    // Pixi marks every mask container non-measurable. A full-stage mask at the
    // top of the game timeline would otherwise be the target of every click,
    // and its scope holds no Flash hit, so the scoped pick would settle on a
    // hit state far behind the real target.
    if (container.measurable === false) return true;
    if (container.hitArea) {
      const p = leafPoint(container, location);
      if (!container.hitArea.contains(p.x, p.y)) return true;
      // The default prune re-tests hitArea with worldTransform; skip to effects.
      const area = container.hitArea;
      container.hitArea = null;
      try { return prune(container, location); } finally { container.hitArea = area; }
    }
    return prune(container, location);
  };
  const hitTest = boundary.hitTest.bind(boundary);
  boundary.hitTest = (x, y) => { stamp++; return hitTest(x, y); };
  let allowed = null;
  stats.pixiEventPicks = 0;
  stats.pixiEventTargets = 0;
  stats.pixiEventCandidates = 0;
  stats.pixiEventHits = 0;
  stats.pixiEventFallbacks = 0;
  stats.configuration.pixiEvents = true;
  stats.configuration.pixiEventsNativePress = nativePress;
  function viewCollision(x, y, ...args) {
    const manager = player._mouseManager;
    // Dragging keeps exact native routing. Press, release and wheel use the
    // same scoped pick as hover (with the full-tree fallback on a miss) unless
    // nativePress asks for the original per-click full pick: in combat, clicks
    // arrive on most ticks and each full pick costs as much as a whole frame.
    // A pending press collision must not switch the release to the native
    // pick: a click only fires when both resolve to the same root, so the
    // release has to be computed the same way as the press was.
    const pointers = Object.values(manager?._pointerDataArray || {});
    if (this.dragNode || manager?._isAVM1Dragging ||
        pointers.some(p => nativePress && (p.dragCollision ||
          p.queuedEvents?.some(event => event.type !== p.move?.type))))
      return originalViewCollision.call(this, x, y, ...args);
    const view = this.node?.view;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !view?.width || !view?.height)
      return originalViewCollision.call(this, x, y, ...args);
    stats.pixiEventPicks++;
    let target;
    try { target = boundary.hitTest(x * renderer.width / view.width, y * renderer.height / view.height); }
    catch { target = null; }
    if (target) stats.pixiEventTargets++;
    let candidate = null;
    for (let p = target; p && !candidate; p = p.parent) candidate = owners.get(p);
    stats.pixiEventLast = { target: target?.constructor?.name || null,
      candidate: candidate?.name || candidate?.assetType || null };
    // Diagnostics only: the Flash node itself, kept out of JSON dumps.
    Object.defineProperty(stats.pixiEventLast, "node", { value: candidate, enumerable: false });
    if (!candidate || !records.has(candidate)) {
      stats.pixiEventFallbacks++;
      return originalViewCollision.call(this, x, y, ...args);
    }
    stats.pixiEventCandidates++;
    function pick(scope) {
      const path = new Set(), scopes = new Set([scope]);
      // A masked entity only counts when the mask's own picker also hits, and
      // the mask is a display object of its own, usually a sibling of the
      // content it clips (a list's mask layer). Admit the masks of every
      // admitted ancestor, with their subtrees, or the clipped content is
      // silently dropped from the scoped pick.
      const admit = node => {
        for (let p = node; p && !path.has(p); p = p.parent) {
          path.add(p);
          if (p.mask) { scopes.add(p.mask); admit(p.mask); }
          if (p._timelineMasks) for (const mask of p._timelineMasks) { scopes.add(mask); admit(mask); }
        }
      };
      admit(scope);
      // Invisible hit states (button hit areas, walkable regions) can sit above
      // the Pixi candidate without any art. Admit every hit-state owner so the
      // native pick can prefer them exactly as the full tree would.
      if (hitStates) for (const owner of hitStates()) admit(owner);
      const previous = allowed;
      allowed = { path, scopes };
      try { return originalViewCollision.call(picker, x, y, ...args); }
      finally { allowed = previous; }
    }
    // Try the candidate's own branch first: for a hit on a room's background
    // art the parent is the whole room, and picking it costs as much as the
    // full tree. Widen to the parent and grandparent only when that misses.
    const parent = candidate.parent && candidate.parent !== player.root ? candidate.parent : null;
    let collision = pick(candidate);
    if (!collision && parent) collision = pick(parent);
    if (!collision && parent?.parent && parent.parent !== player.root)
      collision = pick(parent.parent);
    if (collision) {
      stats.pixiEventHits++;
      return collision;
    }
    stats.pixiEventFallbacks++;
    return originalViewCollision.call(this, x, y, ...args);
  }
  function inScope(node) {
    const container = node?.container;
    if (!container) return true;
    // A button's hit state is a separate node subtree parented under its
    // owner and may sit outside the display list; admit it exactly when the
    // owner is. Climb node parents to the hit-state link.
    for (let n = node; n; n = n.parent) {
      const owner = n.parent;
      if (owner && owner.container?.pickObject === n.container) return inScope(owner);
    }
    for (let p = container; p; p = p.parent) if (allowed.scopes.has(p)) return true;
    return allowed.path.has(container);
  }
  function getTraverser(node) {
    if (allowed && !inScope(node)) return null;
    return originalGetTraverser.call(this, node);
  }
  picker.getViewCollision = viewCollision;
  prototype.getTraverser = getTraverser;
  return () => {
    if (picker.getViewCollision === viewCollision) picker.getViewCollision = originalViewCollision;
    if (prototype.getTraverser === getTraverser) prototype.getTraverser = originalGetTraverser;
    stats.configuration.pixiEvents = false;
  };
}
