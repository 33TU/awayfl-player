// Compare multi-contour Pixi fills against the existing mesh tessellator.
export async function checkCompoundFill(player) {
  const g = player.root._children.find(n => n.name === 'scene').adapter, s = g.sec;
  const hidden = g.adaptee._children.map(n => [n, n.visible]);
  for (const [n] of hidden) n.visible = false;
  const ring = s.flash.display.Sprite.axClass.axConstruct([]);
  const islands = s.flash.display.Sprite.axClass.axConstruct([]);
  const nested = s.flash.display.Sprite.axClass.axConstruct([]);
  const four = s.flash.display.Sprite.axClass.axConstruct([]);
  const intersecting = s.flash.display.Sprite.axClass.axConstruct([]);
  const overlapTwo = s.flash.display.Sprite.axClass.axConstruct([]);
  g.$BgaddChild(ring); ring.$Bgx = 160; ring.$Bgy = 140;
  g.$BgaddChild(islands); islands.$Bgx = 340; islands.$Bgy = 140;
  g.$BgaddChild(nested); nested.$Bgx = 520; nested.$Bgy = 140;
  g.$BgaddChild(four); four.$Bgx = 680; four.$Bgy = 140;
  g.$BgaddChild(intersecting); intersecting.$Bgx = 830; intersecting.$Bgy = 140;
  g.$BgaddChild(overlapTwo); overlapTwo.$Bgx = 830; overlapTwo.$Bgy = 270;
  function rect(graphics, x, y, width, height) {
    graphics.$BgmoveTo(x, y); graphics.$BglineTo(x + width, y);
    graphics.$BglineTo(x + width, y + height); graphics.$BglineTo(x, y + height);
    graphics.$BglineTo(x, y);
  }
  ring.$Bggraphics.$BgbeginFill(0xff4020);
  rect(ring.$Bggraphics, 0, 0, 100, 100);
  rect(ring.$Bggraphics, 30, 30, 40, 40);
  ring.$Bggraphics.$BgendFill();
  islands.$Bggraphics.$BgbeginFill(0x20cf70);
  rect(islands.$Bggraphics, 0, 0, 30, 100);
  rect(islands.$Bggraphics, 70, 0, 30, 100);
  islands.$Bggraphics.$BgendFill();
  nested.$Bggraphics.$BgbeginFill(0x4060ee);
  rect(nested.$Bggraphics, 0, 0, 100, 100);
  rect(nested.$Bggraphics, 20, 20, 60, 60);
  rect(nested.$Bggraphics, 40, 40, 20, 20);
  nested.$Bggraphics.$BgendFill();
  four.$Bggraphics.$BgbeginFill(0xf08020);
  rect(four.$Bggraphics, 0, 0, 100, 100);
  rect(four.$Bggraphics, 20, 20, 60, 60);
  rect(four.$Bggraphics, 35, 35, 30, 30);
  rect(four.$Bggraphics, 45, 45, 10, 10);
  four.$Bggraphics.$BgendFill();
  intersecting.$Bggraphics.$BgbeginFill(0xff00ff);
  rect(intersecting.$Bggraphics, 0, 0, 40, 60);
  rect(intersecting.$Bggraphics, 20, 20, 40, 60);
  rect(intersecting.$Bggraphics, 80, 0, 20, 20);
  intersecting.$Bggraphics.$BgendFill();
  overlapTwo.$Bggraphics.$BgbeginFill(0xff00ff);
  rect(overlapTwo.$Bggraphics, 0, 0, 40, 60);
  rect(overlapTwo.$Bggraphics, 20, 20, 40, 60);
  overlapTwo.$Bggraphics.$BgendFill();
  function frame() {
    player._renderer.render();
    if (pixiLive.stats.lastError) throw Error(pixiLive.stats.lastError);
  }
  function shape(sprite) {
    return pixiLive.getDisplayObject(sprite).children[0].children.find(c => c.context);
  }
  function sample(sprite, x, y) {
    const canvas = player._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');
    const gl = canvas.getContext('webgl2'), result = new Uint8Array(4);
    const point = pixiLive.getDisplayObject(sprite).toGlobal({ x, y });
    gl.readPixels(Math.floor(point.x), canvas.height - 1 - Math.floor(point.y),
      1, 1, gl.RGBA, gl.UNSIGNED_BYTE, result);
    return Array.from(result);
  }
  const pixels = () => [
    sample(ring, 15, 50), sample(ring, 50, 50), sample(ring, 85, 50),
    sample(islands, 15, 50), sample(islands, 50, 50), sample(islands, 85, 50),
    sample(nested, 10, 50), sample(nested, 30, 50), sample(nested, 50, 50),
    sample(four, 10, 50), sample(four, 25, 50), sample(four, 40, 50), sample(four, 50, 50),
  ];
  try {
    pixiLiveControls.stop(); await pixiLiveControls.enable({ nativeGraphics: false, cacheScenery: false });
    frame(); frame(); const reference = pixels();
    pixiLiveControls.stop(); await pixiLiveControls.enable({ nativeGraphics: true, cacheScenery: false });
    frame(); frame(); const actual = pixels();
    if (!shape(ring) || !shape(islands) || !shape(nested) || !shape(four) ||
        shape(intersecting) || shape(overlapTwo))
      throw Error('Multi-contour fill did not use Pixi Graphics: ' + JSON.stringify({
        ring: !!shape(ring), islands: !!shape(islands), nested: !!shape(nested),
        four: !!shape(four), intersecting: !!shape(intersecting), overlapTwo: !!shape(overlapTwo),
        unsupported: pixiLive.stats.unsupported }));
    let maxDelta = 0;
    for (let i = 0; i < actual.length; i++) for (let c = 0; c < 4; c++)
      maxDelta = Math.max(maxDelta, Math.abs(actual[i][c] - reference[i][c]));
    if (reference[0][0] < 200 || reference[1][0] > 20 || reference[2][0] < 200 ||
        reference[3][1] < 150 || reference[4][1] > 20 || reference[5][1] < 150 ||
        reference[6][2] < 180 || reference[7][2] > 20 || reference[8][2] < 180 ||
        reference[9][0] < 180 || reference[10][0] > 20 ||
        reference[11][0] < 180 || reference[12][0] > 20)
      throw Error('Reference compound fill was unexpected: ' + JSON.stringify(reference));
    if (maxDelta > 8)
      throw Error('Native compound fill differs from mesh: ' + JSON.stringify({ reference, actual, maxDelta }));
    const context = shape(ring).context, builds = pixiLive.stats.nativePathBuilds;
    ring.$Bgx += 10; frame();
    if (shape(ring)?.context !== context || pixiLive.stats.nativePathBuilds !== builds)
      throw Error('Moving a compound fill rebuilt its context');
    return { reference, actual, maxDelta, reused: true };
  } finally {
    for (const sprite of [ring, islands, nested, four, intersecting, overlapTwo]) g.$BgremoveChild(sprite);
    for (const [n, visible] of hidden) n.visible = visible;
    frame();
  }
}
