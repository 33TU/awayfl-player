// Experimental broad phase for Flash input. The retained Pixi tree supplies
// screen bounds; AwayFL still resolves ordering, masks and precise collisions
// for branches that survive. Some Flash hit areas extend past visual bounds,
// so this remains opt-in until those cases have their own bounds.
export function installPixiPickBounds(player, records, stats, renderer, { minChildren = 3, padding = 12 } = {}) {
  const picker = player?._mousePicker;
  const prototype = picker && Object.getPrototypeOf(picker);
  if (!prototype || typeof picker.getViewCollision !== "function" ||
      typeof prototype.getTraverser !== "function") return;
  const originalViewCollision = picker.getViewCollision;
  const originalGetTraverser = prototype.getTraverser;
  let point = null;
  let bounds = new WeakMap();
  stats.pixiPickBoundsChecks = 0;
  stats.pixiPickBoundsSkips = 0;
  stats.pixiPickBoundsMs = 0;
  stats.configuration.pixiPickBounds = true;
  function viewCollision(x, y, ...args) {
    const previous = point;
    const view = this.node?.view;
    const width = view?.width, height = view?.height;
    // Flash hit areas can extend outside their visual Pixi bounds. Keep
    // press/release and drag targeting exact; only hover/movement uses the
    // approximate broad phase.
    const manager = player._mouseManager;
    let precise = !!manager?._isAVM1Dragging || !!this.dragNode;
    if (!precise) for (const pointer of Object.values(manager?._pointerDataArray || {})) {
      if (pointer.dragCollision || pointer.queuedEvents?.some(event =>
        event.type === pointer.down?.type || event.type === pointer.up?.type)) {
        precise = true;
        break;
      }
    }
    point = !precise && Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0
      ? { x: x * renderer.width / width, y: y * renderer.height / height }
      : null;
    bounds = new WeakMap();
    try { return originalViewCollision.call(this, x, y, ...args); }
    finally { point = previous; }
  }
  function getTraverser(node) {
    if (point && node?._numChildNodes >= minChildren &&
        !node.isDragEntity?.() && !node.container?.pickObject) {
      const outer = records.get(node.container)?.outer;
      if (outer?.parent && outer.visible) {
        const start = performance.now();
        let box = bounds.get(outer);
        if (!box) {
          try { box = outer.getBounds(); }
          catch { box = null; }
          if (box) bounds.set(outer, box);
        }
        stats.pixiPickBoundsMs += performance.now() - start;
        if (box && Number.isFinite(box.x) && Number.isFinite(box.y) &&
            Number.isFinite(box.width) && Number.isFinite(box.height) &&
            box.width > 0 && box.height > 0) {
          stats.pixiPickBoundsChecks++;
          if (point.x < box.x - padding || point.x > box.x + box.width + padding ||
              point.y < box.y - padding || point.y > box.y + box.height + padding) {
            stats.pixiPickBoundsSkips++;
            return null;
          }
        }
      }
    }
    return originalGetTraverser.call(this, node);
  }
  picker.getViewCollision = viewCollision;
  prototype.getTraverser = getTraverser;
  return () => {
    if (picker.getViewCollision === viewCollision) picker.getViewCollision = originalViewCollision;
    if (prototype.getTraverser === getTraverser) prototype.getTraverser = originalGetTraverser;
    stats.configuration.pixiPickBounds = false;
  };
}
