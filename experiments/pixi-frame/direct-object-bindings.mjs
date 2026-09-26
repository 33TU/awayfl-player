// A Flash object owns its Pixi container for the lifetime of this backend.
// Observe the shared mutation methods so timeline super.addChildAt calls are
// covered too. Restore every hook when switching back to the native renderer.
const PIXI_OBJECT = Symbol("flash-pixi-object");
export function createDirectObjectBindings({ record, update, changed, linearChanged = null, hierarchyChanged = () => {}, detached = () => {}, stats, profiler, reuseTranslations = true, retainMaskedContent = true, skipUnchangedColors = true }) {
  const owned = new Map(), hooks = [];
  const patched = new WeakMap();
  let stopped = false;
  function hook(proto, name, after) {
    let names = patched.get(proto);
    if (!names) patched.set(proto, names = new Set());
    if (names.has(name)) return;
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (typeof descriptor?.value !== "function") return;
    names.add(name);
    const original = descriptor.value;
    function wrapper(...args) {
      const previousParent = name === "_setParent" ? this.parent : null;
      const result = original.apply(this, args);
      if (!stopped) {
        const end = profiler?.section("bindings");
        try { after(this, args, previousParent); }
        finally { end?.(); }
      }
      return result;
    }
    Object.defineProperty(proto, name, { ...descriptor, value: wrapper });
    hooks.push(() => {
      if (Object.getOwnPropertyDescriptor(proto, name)?.value === wrapper)
        Object.defineProperty(proto, name, descriptor);
    });
  }
  function refresh(node, args) {
    const r = owned.get(node);
    if (!r || r.updating) return;
    r.updating = true;
    try {
      // Only COLOR_TRANSFORM, or a full/combined invalidation containing it,
      // establishes a new observed color. A transform-only notification must
      // not consume an as-yet-unreported color edit. Copy the eight values:
      // timelines mutate the same typed array in place.
      const flags = args?.[0];
      const color = flags === undefined || (flags & 16)
        ? node.transform.colorTransform?._rawData : null;
      if (color?.length === 8) {
        if (skipUnchangedColors && flags === 16 && r.bindingColor &&
            r.bindingColor.every((v, i) => v === color[i])) {
          stats.unchangedColorUpdates++;
          return; // Leave existing self/descendant dirtiness intact.
        }
        r.bindingColor = Array.from(color);
      } else if (flags === undefined || (flags & 16)) {
        r.bindingColor = null;
      }
      // MASKS changes the Pixi wrappers/scroll rectangle on this object, not
      // descendant geometry or inherited paint. Still visit it and resolve
      // masks after hierarchy updates; retain independently dirty descendants.
      // Mixed flags and MASK_ID (mask geometry becoming hidden/visible) keep
      // the conservative path below. Native picking invalidation already ran.
      if (retainMaskedContent && args?.[0] === 8) {
        stats.localMaskUpdates++;
        changed(r, false, false);
        return;
      }
      const before = r.transform, was3D = r.is3D;
      update(node, r);
      // HierarchicalProperty.SCENE_TRANSFORM = 32 in the native runtime.
      // Pixi propagates translation through its retained hierarchy. Descendant
      // geometry, inherited color and scale-dependent strokes/filters don't
      // change when the parent's 2D linear matrix stays identical.
      const translation = reuseTranslations && args?.[0] === 32 && before &&
        !was3D && !r.is3D && r.transform &&
        before[0] === r.transform[0] && before[1] === r.transform[1] &&
        before[2] === r.transform[2] && before[3] === r.transform[3];
      if (translation) stats.translationReuses++;
      // A rotation or scale also propagates through Pixi. Only subtrees whose
      // Pixi content depends on the world transform (filters, native text,
      // screen-space strokes, scenery rasters, 3D) need re-preparation.
      const linear = !translation && linearChanged && reuseTranslations && args?.[0] === 32 &&
        before && !was3D && !r.is3D && r.transform;
      if (linear) {
        stats.linearReuses++;
        linearChanged(r);
        return;
      }
      // Translation is already applied to the Pixi container above. Keep any
      // pending content dirtiness, but don't request a fresh mesh preparation.
      changed(r, !translation, !translation);
    } finally { r.updating = false; }
  }
  function attach(parent, child) {
    const r = owned.get(parent);
    if (!r) return;
    const c = own(child);
    const index = parent._children.indexOf(child);
    if (index < 0) return;
    if (c.outer.parent !== r.childLayer || r.childLayer.children[index] !== c.outer) {
      // Earlier siblings may not have been adopted yet during initial setup.
      r.childLayer.addChildAt(c.outer, Math.min(index, r.childLayer.children.length));
      hierarchyChanged(r);
      changed(r);
      stats.directHierarchyUpdates++;
    }
  }
  function own(node) {
    let r = owned.get(node);
    if (r) return r;
    r = record(node);
    owned.set(node, r);
    Object.defineProperty(node, PIXI_OBJECT, { value: r.outer, configurable: true });
    for (let p = Object.getPrototypeOf(node); p; p = Object.getPrototypeOf(p)) {
      hook(p, "_invalidateHierarchicalProperty", refresh);
      // Graphics, text, filters and blend-mode setters invalidate their owner.
      for (const name of ["invalidate", "_invalidateStyle", "_invalidateMaterial", "invalidateElements"])
        hook(p, name, (node) => {
          const r = owned.get(node);
          if (r) changed(r);
        });
      hook(p, "addChildAt", (parent, args) => attach(parent, args[0]));
      hook(p, "_setParent", (child, args, oldParent) => {
        if (!owned.has(child)) return;
        const parent = args[0];
        if (oldParent !== parent) {
          const r = owned.get(child);
          r.outer.removeFromParent();
          hierarchyChanged(owned.get(oldParent));
          hierarchyChanged(r);
          changed(owned.get(oldParent));
          changed(r, true);
          detached(r);
          stats.directHierarchyUpdates++;
        }
        if (parent) attach(parent, child);
      });
    }
    refresh(node);
    for (const child of node._children || []) attach(node, child);
    if (owned.has(node.parent)) attach(node.parent, node);
    return r;
  }
  function release(node) {
    const r = owned.get(node);
    if (!r) return;
    if (node[PIXI_OBJECT] === r.outer) delete node[PIXI_OBJECT];
    owned.delete(node);
  }
  return {
    own,
    get(node) { return node?.[PIXI_OBJECT]; },
    release,
    destroy() {
      stopped = true;
      for (const node of owned.keys()) release(node);
      for (const restore of hooks.reverse()) restore();
    },
  };
}
