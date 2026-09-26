// Skip stationary hover picks while Pixi's retained scene is unchanged, with an
// optional cadence limit. Checked ticks keep native dispatch and hit testing.
export function installIdleHover(player, stats, hz = 0, now = () => performance.now(), getRevision = null) {
  const manager = player?._mouseManager, picker = player?._mousePicker;
  const cadence = Number.isFinite(hz) && hz > 0;
  const retained = typeof getRevision === "function";
  if ((!cadence && !retained) || !picker || typeof manager?.fireMouseEvents !== "function")
    return;
  const original = manager.fireMouseEvents;
  const interval = cadence ? 1000 / hz : 0;
  let lastCheck = -Infinity, lastX, lastY, lastWidth, lastHeight, lastRevision, busy = false;
  stats.idleHoverHz = cadence ? hz : 0;
  stats.retainedHover = retained;
  function wrapper(forcePicker, ...args) {
    // Other picker callers and unknown runtime layouts retain native behavior.
    const pointers = manager._pointerDataArray;
    const mouse = pointers?.[0];
    let idle = !busy && forcePicker === picker && !manager._updateDirty &&
      !manager._isAVM1Dragging && !picker.dragNode && mouse?.isMouse &&
      Array.isArray(mouse.queuedEvents) && !mouse.queuedEvents.length &&
      !mouse.dragCollision && !mouse.sourceEvent?.buttons;
    if (idle) for (const key in pointers) if (key !== "0") { idle = false; break; }
    const width = player._view?.width, height = player._view?.height;
    const time = now();
    const revision = retained ? getRevision() : undefined;
    if (idle && mouse.screenX === lastX && mouse.screenY === lastY &&
        width === lastWidth && height === lastHeight &&
        ((retained && revision === lastRevision) || (cadence && time - lastCheck < interval))) {
      stats.hoverSkips++;
      return;
    }
    if (forcePicker === picker && !busy) {
      lastCheck = time;
      lastX = mouse?.screenX; lastY = mouse?.screenY;
      lastWidth = width; lastHeight = height;
      lastRevision = revision;
      stats.hoverChecks++;
    }
    const wasBusy = busy; busy = true;
    try { return original.call(this, forcePicker, ...args); }
    finally { busy = wasBusy; }
  }
  manager.fireMouseEvents = wrapper;
  return () => {
    if (manager.fireMouseEvents === wrapper) manager.fireMouseEvents = original;
    stats.idleHoverHz = 0;
    stats.retainedHover = false;
  };
}
