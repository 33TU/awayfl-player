// Native mask mutations must update retained Pixi clipping without preparing
// unrelated descendant geometry. Readbacks are confined to this offline check.
export async function checkMaskUpdates(player, live) {
  const g = player.root._children.find(n => n.name === "scene").adapter, s = g.sec;
  const hidden = g.adaptee._children.map(n => [n, n.visible]);
  for (const [n] of hidden) n.visible = false;
  const sprite = () => s.flash.display.Sprite.axClass.axConstruct([]);
  const parent = sprite(), maskA = sprite(), maskB = sprite();
  const nodes = [parent, maskA, maskB];
  for (const node of nodes) { g.$BgaddChild(node); node.$Bgx = 100; node.$Bgy = 100; }
  function rect(node, color, width, height) {
    node.$Bggraphics.$BgbeginFill(color);
    node.$Bggraphics.$BgdrawRect(0, 0, width, height);
    node.$Bggraphics.$BgendFill();
  }
  rect(maskA, 0xffffff, 85, 165); rect(maskB, 0xffffff, 165, 85);
  rect(parent, 0x224477, 170, 170);
  parent.$Bgfilters = s.createArray([new s.flash.filters.GlowFilter(0xff6600, 1, 4, 4, 1, 1)]);
  const children = [];
  for (let i = 0; i < 64; i++) {
    const child = sprite(); parent.$BgaddChild(child); children.push(child);
    child.$Bgx = i % 8 * 20; child.$Bgy = Math.floor(i / 8) * 20;
    rect(child, 0x22cc88, 12, 12);
  }
  const canvas = player._view.stage.context._gl.canvas.ownerDocument.querySelector("[data-pixi-display-list]");
  const gl = canvas.getContext("webgl2");
  function frame() {
    player._renderer.render();
    const bytes = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return { bytes, prepared: live.stats.preparedContents, retained: live.stats.retainedContents,
      meshes: live.stats.meshes, diagnostics: JSON.stringify(Object.entries(live.stats.unsupported).sort()) };
  }
  const cases = [], initialUpdates = live.stats.localMaskUpdates;
  try {
    frame(); frame();
    for (const [name, change] of [
      ["empty-timeline", () => { parent.adaptee.timelineMasks = undefined; }],
      ["script-add", () => { parent.$Bgmask = maskA; }],
      ["script-replace", () => { parent.$Bgmask = maskB; }],
      ["mask-move", () => { maskB.$Bgx += 20; }],
      ["mask-geometry", () => { rect(maskB, 0xffffff, 85, 150); }],
      ["script-remove", () => { parent.$Bgmask = null; }],
      ["timeline-add", () => { parent.adaptee.timelineMasks = [maskA.adaptee]; }],
      ["timeline-repeat", () => { parent.adaptee.timelineMasks = [maskA.adaptee]; }],
      ["timeline-intersection", () => { parent.adaptee.timelineMasks = [maskA.adaptee, maskB.adaptee]; }],
      ["timeline-child-edit", () => { parent.adaptee.timelineMasks = [maskB.adaptee]; rect(children[0], 0xff0000, 18, 18); }],
      ["timeline-remove", () => { parent.adaptee.timelineMasks = undefined; }],
      ["scroll-add", () => { parent.$BgscrollRect = new s.flash.geom.Rectangle(0, 0, 90, 130); }],
      ["scroll-move", () => { parent.$BgscrollRect = new s.flash.geom.Rectangle(20, 10, 90, 130); }],
      ["scroll-remove", () => { parent.$BgscrollRect = null; }],
    ]) {
      change(); const retained = frame();
      parent.adaptee._invalidateHierarchicalProperty(255);
      const forced = frame();
      let maxDelta = 0;
      for (let i = 0; i < retained.bytes.length; i++) maxDelta = Math.max(maxDelta, Math.abs(retained.bytes[i] - forced.bytes[i]));
      if (maxDelta) throw Error(`Mask update ${name}: pixel delta ${maxDelta}`);
      if (retained.meshes !== forced.meshes || retained.diagnostics !== forced.diagnostics)
        throw Error(`Mask update ${name}: summary mismatch`);
      // scrollRect also emits native geometry/transform invalidations while
      // creating its clip primitive. Those retain the conservative path.
      if (!name.startsWith("scroll-") && retained.prepared >= forced.prepared)
        throw Error(`Mask update ${name}: descendant content was re-prepared`);
      cases.push({ name, maxDelta, prepared: retained.prepared, retained: retained.retained, forced: forced.prepared });
    }
    return { cases, localMaskUpdates: live.stats.localMaskUpdates - initialUpdates };
  } finally {
    parent.$Bgmask = null; parent.adaptee.timelineMasks = undefined;
    for (const node of nodes) g.$BgremoveChild(node);
    for (const [n, visible] of hidden) n.visible = visible;
    player._renderer.render();
  }
}
