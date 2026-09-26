import { EventBoundary } from "pixi.js";

// Pixi owns the broad target choice; AwayFL still creates PickingCollision and
// dispatches Flash mouse events. Retry the full tree when a visual Pixi target
// does not correspond to a Flash hit (e.g. a button with a custom hit area).
export function installPixiPickEvents(player, scene, records, owners, renderer, stats, { nativePress = false } = {}) {
  const picker = player?._mousePicker;
  const prototype = picker && Object.getPrototypeOf(picker);
  if (!prototype || typeof picker.getViewCollision !== "function" ||
      typeof prototype.getTraverser !== "function") return;
  const originalViewCollision = picker.getViewCollision;
  const originalGetTraverser = prototype.getTraverser;
  const boundary = new EventBoundary(scene);
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
    // A button's hit state is a separate node parented under its owner and
    // may sit outside the display list; admit it exactly when its owner is.
    const parent = node.parent;
    if (parent && parent.container?.pickObject === container) return inScope(parent);
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
