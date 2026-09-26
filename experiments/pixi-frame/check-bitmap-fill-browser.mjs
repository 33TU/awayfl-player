// Offline bitmap-fill fixture. Compare repeated native Pixi graphics against
// the existing textured mesh and check shared geometry and live image edits.
export async function checkBitmapFill(player) {
  const g = player.root._children.find(n => n.name === 'scene').adapter, s = g.sec;
  const hidden = g.adaptee._children.map(n => [n, n.visible]);
  for (const [n] of hidden) n.visible = false;
  const image = new s.flash.display.BitmapData(8, 8, true, 0xffff0000);
  image.adaptee.fillRect(image.adaptee.rect, 0xffff0000, true);
  function colorRight(r, g, b) {
    const bytes = image.adaptee.getDataInternal(true, false);
    for (let y = 0; y < 8; y++) for (let x = 4; x < 8; x++)
      bytes.set([r, g, b, 255], (y * 8 + x) * 4);
    image.adaptee.invalidateGPU();
  }
  colorRight(0, 0, 255);
  const a = s.flash.display.Sprite.axClass.axConstruct([]);
  const b = s.flash.display.Sprite.axClass.axConstruct([]);
  const clamped = s.flash.display.Sprite.axClass.axConstruct([]);
  for (const [sprite, x] of [[a, 120], [b, 320], [clamped, 520]]) {
    g.$BgaddChild(sprite); sprite.$Bgx = x; sprite.$Bgy = 140;
  }
  const matrix = s.flash.geom.Matrix.axClass.axConstruct([8, 0, 0, 8, 0, 0]);
  function draw(sprite, repeat) {
    const graphics = sprite.$Bggraphics;
    graphics.$BgbeginBitmapFill(image, matrix, repeat, false);
    graphics.$BgmoveTo(0, 0); graphics.$BglineTo(144, 0);
    graphics.$BglineTo(144, 64); graphics.$BglineTo(0, 64);
    graphics.$BglineTo(0, 0); graphics.$BgendFill();
  }
  draw(a, true); a.adaptee.graphics.copyTo(b.adaptee.graphics);
  draw(clamped, false);
  function frame() {
    player._renderer.render();
    if (pixiLive.stats.lastError) throw Error(pixiLive.stats.lastError);
  }
  function shape(sprite) {
    return pixiLive.getDisplayObject(sprite).children[0].children.find(c => c.context);
  }
  function sample(sprite, x) {
    const canvas = player._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');
    const gl = canvas.getContext('webgl2'), result = new Uint8Array(4);
    const point = pixiLive.getDisplayObject(sprite).toGlobal({ x, y: 32 });
    gl.readPixels(Math.floor(point.x), canvas.height - 1 - Math.floor(point.y),
      1, 1, gl.RGBA, gl.UNSIGNED_BYTE, result);
    return Array.from(result);
  }
  const pixels = () => [16, 48, 80, 112].map(x => sample(a, x));
  try {
    pixiLiveControls.stop(); await pixiLiveControls.enable({ nativeGraphics: false, cacheScenery: false });
    frame(); frame(); const reference = pixels();
    pixiLiveControls.stop(); await pixiLiveControls.enable({ nativeGraphics: true, cacheScenery: false });
    frame(); frame();
    const native = shape(a), copied = shape(b);
    if (!native || copied?.context !== native.context)
      throw Error('Bitmap fill did not use a shared Pixi GraphicsContext: ' +
        JSON.stringify({ native: !!native, copied: !!copied,
          same: native?.context === copied?.context,
          stats: { nativeBitmaps: pixiLive.stats.nativeBitmaps,
            meshes: pixiLive.stats.meshes, unsupported: pixiLive.stats.unsupported },
          fill: a.adaptee.graphics._fillStyle?.fillStyle && {
            type: a.adaptee.graphics._fillStyle.fillStyle.data_type,
            repeat: a.adaptee.graphics._fillStyle.fillStyle.repeat },
          shapes: a.adaptee.graphics.shapes?.map(sh => ({
            original: sh.originalFillStyle?.data_type,
            image: !!sh.style?.image, uv: !!sh.style?.uvMatrix })) }));
    if (shape(clamped) || pixiLive.stats.nativeBitmaps !== 2)
      throw Error('Non-repeating bitmap must stay on the mesh path');
    const actual = pixels(); let maxDelta = 0;
    for (let i = 0; i < actual.length; i++) for (let c = 0; c < 4; c++)
      maxDelta = Math.max(maxDelta, Math.abs(actual[i][c] - reference[i][c]));
    if (reference[0][0] < 200 || reference[1][2] < 200 ||
        reference[2][0] < 200 || reference[3][2] < 200)
      throw Error('Reference bitmap repeat was unexpected: ' + JSON.stringify(reference));
    if (maxDelta > 8)
      throw Error('Native bitmap fill differs from mesh: ' + JSON.stringify({ reference, actual, maxDelta }));
    const context = native.context, builds = pixiLive.stats.nativePathBuilds;
    a.$Bgx += 10; frame();
    if (shape(a)?.context !== context || pixiLive.stats.nativePathBuilds !== builds)
      throw Error('Moving a bitmap fill rebuilt its context');
    colorRight(0, 255, 0);
    frame(); frame(); const edited = sample(a, 48);
    if (edited[1] < 200 || edited[2] > 20)
      throw Error('Bitmap edit did not refresh native fill: ' + edited);
    a.$Bgvisible = false; b.$Bgvisible = false;
    for (let i = 0; i < 5; i++) frame();
    a.$Bgvisible = true; b.$Bgvisible = true; frame();
    if (shape(a)?.context !== context || sample(a, 48)[1] < 200)
      throw Error('Restoring a hidden bitmap fill lost its texture or context');
    return { reference, actual, maxDelta, edited, shared: true,
      hiddenRestore: true, clampedFallback: true };
  } finally {
    for (const sprite of [a, b, clamped]) g.$BgremoveChild(sprite);
    for (const [n, visible] of hidden) n.visible = visible;
    frame();
  }
}
