import { EventBoundary, Matrix } from "pixi.js";

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
  // and the default hit test misses it. Derive world transforms from the
  // local transform chain instead; the cache is cleared per hit test.
  const worlds = new Map();
  const worldOf = container => {
    let m = worlds.get(container);
    if (m) return m;
    container.updateLocalTransform?.();
    m = new Matrix().copyFrom(container.localTransform);
    if (container.parent && container !== scene) m.prepend(worldOf(container.parent));
    worlds.set(container, m);
    return m;
  };
  const local = { x: 0, y: 0 };
  boundary.hitTestFn = (container, location) => {
    if (container.hitArea) return true;
    if (!container.containsPoint) return false;
    worldOf(container).applyInverse(location, local);
    return container.containsPoint(local);
  };
  const prune = boundary.hitPruneFn;
  boundary.hitPruneFn = (container, location) => {
    if (container.hitArea) {
      worldOf(container).applyInverse(location, local);
      if (!container.hitArea.contains(local.x, local.y)) return true;
      // The default prune re-tests hitArea with worldTransform; skip to effects.
      const area = container.hitArea;
      container.hitArea = null;
      try { return prune(container, location); } finally { container.hitArea = area; }
    }
    return prune(container, location);
  };
  const hitTest = boundary.hitTest.bind(boundary);
  boundary.hitTest = (x, y) => { worlds.clear(); try { return hitTest(x, y); } finally { worlds.clear(); } };
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
    if (this.dragNode || manager?._isAVM1Dragging ||
        Object.values(manager?._pointerDataArray || {}).some(p => p.dragCollision ||
          (nativePress && p.queuedEvents?.some(event => event.type !== p.move?.type))))
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
    if (!candidate || !records.has(candidate)) {
      stats.pixiEventFallbacks++;
      return originalViewCollision.call(this, x, y, ...args);
    }
    stats.pixiEventCandidates++;
    function pick(scope) {
      const path = new Set();
      for (let p = scope; p; p = p.parent) path.add(p);
      // Invisible hit states (button hit areas, walkable regions) can sit above
      // the Pixi candidate without any art. Admit every hit-state owner so the
      // native pick can prefer them exactly as the full tree would.
      if (hitStates) for (const owner of hitStates()) for (let p = owner; p; p = p.parent) path.add(p);
      const previous = allowed;
      allowed = { path, scope };
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
    for (let p = container; p; p = p.parent) if (p === allowed.scope) return true;
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
