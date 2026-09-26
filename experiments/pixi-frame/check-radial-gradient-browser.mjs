// Compare radial Pixi fills with the existing mesh path at representative points.
export async function checkRadialGradient(player) {
  const g = player.root._children.find(n => n.name === 'scene').adapter, s = g.sec;
  const hidden = g.adaptee._children.map(n => [n, n.visible]);
  for (const [n] of hidden) n.visible = false;
  const a = s.flash.display.Sprite.axClass.axConstruct([]);
  const b = s.flash.display.Sprite.axClass.axConstruct([]);
  g.$BgaddChild(a); a.$Bgx = 180; a.$Bgy = 120;
  g.$BgaddChild(b); b.$Bgx = 300; b.$Bgy = 120;
  const scale = 80 / 1638.4;
  const matrix = s.flash.geom.Matrix.axClass.axConstruct([scale, 0, 0, scale, 40, 40]);
  a.$Bggraphics.$BgbeginGradientFill('radial', s.createArray([0xff0000, 0x0000ff]),
    s.createArray([1, 1]), s.createArray([0, 255]), matrix, 'pad', 'rgb', 0);
  a.$Bggraphics.$BgmoveTo(0, 0); a.$Bggraphics.$BglineTo(80, 0);
  a.$Bggraphics.$BglineTo(80, 80); a.$Bggraphics.$BglineTo(0, 80);
  a.$Bggraphics.$BglineTo(0, 0); a.$Bggraphics.$BgendFill();
  a.adaptee.graphics.copyTo(b.adaptee.graphics);
  function frame() { player._renderer.render(); if (pixiLive.stats.lastError) throw Error(pixiLive.stats.lastError); }
  function shape(sprite) { return pixiLive.getDisplayObject(sprite).children[0].children.find(c => c.context); }
  function sample(x, y) {
    const canvas = player._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');
    const gl = canvas.getContext('webgl2'), out = new Uint8Array(4);
    const point = pixiLive.getDisplayObject(a).toGlobal({ x, y });
    gl.readPixels(Math.floor(point.x), canvas.height - 1 - Math.floor(point.y),
      1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return Array.from(out);
  }
  const pixels = () => [sample(40, 40), sample(20, 40), sample(5, 40), sample(40, 5)];
  try {
    pixiLiveControls.stop(); await pixiLiveControls.enable({ nativeGraphics: false, cacheScenery: false });
    frame(); frame(); const reference = pixels();
    pixiLiveControls.stop(); await pixiLiveControls.enable({ nativeGraphics: true, cacheScenery: false });
    frame(); frame(); const actual = pixels(), native = shape(a);
    if (!native || shape(b)?.context !== native.context)
      throw Error('Radial gradient did not use a shared Pixi GraphicsContext');
    const gradient = native.context.instructions.find(x => x.action === 'fill')?.data.style.fill;
    if (gradient?.type !== 'radial') throw Error('Expected Pixi FillGradient radial fill');
    if (actual[0][0] <= actual[2][0] || actual[2][2] <= actual[0][2])
      throw Error('Radial center-to-edge colors are reversed: ' + JSON.stringify(actual));
    let maxDelta = 0;
    for (let i = 0; i < actual.length; i++) for (let c = 0; c < 4; c++)
      maxDelta = Math.max(maxDelta, Math.abs(actual[i][c] - reference[i][c]));
    if (maxDelta > 80) throw Error('Native radial gradient diverges strongly: ' + JSON.stringify({ reference, actual, maxDelta }));
    const context = native.context, builds = pixiLive.stats.nativePathBuilds;
    a.$Bgx += 10; frame();
    if (shape(a)?.context !== context || pixiLive.stats.nativePathBuilds !== builds)
      throw Error('Moving a radial gradient rebuilt its context');
    return { reference, actual, maxDelta, shared: true, reused: true };
  } finally {
    g.$BgremoveChild(a); g.$BgremoveChild(b);
    for (const [n, visible] of hidden) n.visible = visible;
    frame();
  }
}
