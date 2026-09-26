import { loadBattleonFixture } from "./fixture.mjs";

export async function checkBitmapDraw(player, live) {
  const host = player.root._children.find(n => n.name === "scene").adapter;
  const s = host.sec;
  const sprite = s.flash.display.Sprite.axClass.axConstruct([]);
  host.$BgaddChild(sprite);
  const graphics = sprite.$Bggraphics;
  graphics.$BgbeginFill(0xff0000, 0.5);
  graphics.$BgdrawRect(0, 0, 12, 8);
  graphics.$BgendFill();
  graphics.$BgbeginFill(0x0000ff);
  graphics.$BgdrawRect(0, 8, 12, 8);
  graphics.$BgendFill();
  sprite.$Bgx = 50;
  sprite.$Bgy = 100;
  player._renderer.render();
  const matrix = new s.flash.geom.Matrix(1, 0, 0, 1, 3, 4);
  const makeBitmap = () => new s.flash.display.BitmapData(30, 40, true, 0x00999999);
  const sample = bitmap => [[5, 5], [5, 15], [5, 25], [0, 0]]
    .map(([x, y]) => bitmap.$BggetPixel32(x, y) >>> 0);
  try {
    const pixi = makeBitmap();
    pixi.$Bgdraw(sprite, matrix);
    if (live.stats.pixiBitmapDraws !== 1) throw Error("Pixi BitmapData.draw did not run");
    const pixiPixels = sample(pixi);
    // A second draw into the used target must retain AwayFL's compositing path.
    pixi.$Bgdraw(sprite, matrix);
    if (live.stats.pixiBitmapDraws !== 1) throw Error("Used target bypassed fallback");
    const child = s.flash.display.Sprite.axClass.axConstruct([]);
    child.$Bgx = 2;
    child.$Bgy = 20;
    child.$Bggraphics.$BgbeginFill(0x00ff00);
    child.$Bggraphics.$BgdrawRect(0, 0, 12, 8);
    child.$Bggraphics.$BgendFill();
    sprite.$BgaddChild(child);
    player._renderer.render();
    const nested = makeBitmap();
    nested.$Bgdraw(sprite, matrix);
    if (live.stats.pixiBitmapDraws !== 2) throw Error("Nested Pixi BitmapData.draw did not run");
    const nestedPixels = sample(nested);
    live.stop();
    const away = makeBitmap();
    away.$Bgdraw(sprite, matrix);
    const awayPixels = sample(away);
    if (nestedPixels.some((v, i) => v !== awayPixels[i]))
      throw Error(`Nested BitmapData.draw pixels differ: ${nestedPixels} vs ${awayPixels}`);
    if (pixiPixels[0] !== awayPixels[0] || pixiPixels[1] !== awayPixels[1] || pixiPixels[3] !== awayPixels[3])
      throw Error(`Simple BitmapData.draw pixels differ: ${pixiPixels} vs ${awayPixels}`);
    return { pixiPixels, nestedPixels, awayPixels, pixiDraws: live.stats.pixiBitmapDraws };
  } finally {
    host.$BgremoveChild(sprite);
  }
}

export async function checkBattleonBitmapDraw(player, live) {
  const fixture = await loadBattleonFixture(player, { drawBitmap: false });
  player.isPaused = true;
  player._renderer.render();
  const before = live.stats.pixiBitmapDraws;
  const { data, source, matrix } = fixture.drawBitmap();
  if (live.stats.pixiBitmapDraws !== before + 1)
    throw Error(`Battleon BitmapData.draw fell back: ${live.stats.pixiBitmapDrawLastSkip || live.stats.pixiBitmapDrawLastError}`);
  live.stop();
  source.$Bgvisible = true;
  const s = source.sec;
  const reference = new s.flash.display.BitmapData(960, 500, true, 0x00999999);
  reference.$Bgdraw(source, matrix, null, null, new s.flash.geom.Rectangle(0, 0, 960, 500), false);
  let error = 0, samples = 0;
  for (let y = 8; y < 500; y += 16) for (let x = 8; x < 960; x += 16) {
    const a = data.$BggetPixel32(x, y) >>> 0;
    const b = reference.$BggetPixel32(x, y) >>> 0;
    error += (Math.abs((a >>> 24) - (b >>> 24)) +
      Math.abs((a >> 16 & 255) - (b >> 16 & 255)) +
      Math.abs((a >> 8 & 255) - (b >> 8 & 255)) +
      Math.abs((a & 255) - (b & 255))) / 4;
    samples++;
  }
  const meanChannelError = error / samples;
  // Flash and Pixi use different antialiasing/filter implementations. This
  // guards against a blank or grossly misplaced capture, not pixel equality.
  if (meanChannelError > 15)
    throw Error(`Battleon Pixi capture differs from AwayFL: ${meanChannelError}`);
  return { pixiDraws: live.stats.pixiBitmapDraws - before, samples, meanChannelError };
}
