// Exercise Flash's actual blendMode setter through capture and Pixi composition.
import { startLive } from "./live.mjs";

export async function checkFlashBlend(player) {
  const game = player.root._children.find((n) => n.name === "scene").adapter;
  const sec = game.sec;
  const gl = player._view.stage.context._gl;
  const paused = player.isPaused;
  player.isPaused = true;
  const children = game.adaptee._children.map((n) => [n, n.visible]);
  for (const [node] of children) node.visible = false;
  function rectangle(parent, color) {
    const sprite = sec.flash.display.Sprite.axClass.axConstruct([]);
    sprite.$Bggraphics.$BgbeginFill(color, 1);
    sprite.$Bggraphics.$BgdrawRect(0, 0, 960, 550);
    sprite.$Bggraphics.$BgendFill();
    parent.$BgaddChild(sprite);
    return sprite;
  }
  const background = rectangle(game, 0x336699);
  const foreground = rectangle(background, 0xcc4cb2);
  foreground.$BgblendMode = "hardlight";
  let bridge;
  const results = [];
  function sample() {
    for (let i = 0; i < 3; i++) player._renderer.render();
    const pixel = new Uint8Array(4);
    gl.readPixels(
      Math.floor(gl.drawingBufferWidth / 2),
      Math.floor(gl.drawingBufferHeight / 2),
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixel,
    );
    return [...pixel];
  }
  try {
    for (const alpha of [1, 0.5]) {
      foreground.$Bggraphics.$Bgclear();
      foreground.$Bggraphics.$BgbeginFill(0xcc4cb2, alpha);
      foreground.$Bggraphics.$BgdrawRect(0, 0, 960, 550);
      foreground.$Bggraphics.$BgendFill();
      const reference = sample();
      bridge = await startLive(player);
      const actual = sample();
      const expected = [51, 102, 153].map((value, i) => {
        const d = value / 255,
          s = [204, 76, 178][i] / 255;
        const blend = s <= 0.5 ? 2 * s * d : 1 - 2 * (1 - s) * (1 - d);
        return Math.round(255 * (d * (1 - alpha) + blend * alpha));
      });
      expected.push(255);
      results.push({
        alpha,
        reference,
        actual,
        expected,
        active: bridge.active,
        lastError: bridge.stats.lastError,
        overlays: bridge.stats.preparation?.overlays,
      });
      bridge.stop();
      bridge = null;
    }
    return { results, glError: gl.getError() };
  } finally {
    bridge?.stop();
    game.$BgremoveChild(background);
    for (const [node, visible] of children) node.visible = visible;
    player.isPaused = paused;
  }
}
