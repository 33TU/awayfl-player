import assert from 'node:assert/strict';
import { installMorphCache } from '../../src/graphics/morph-cache.mjs';

let nextId = 0;
class Graphics {
  static pool = [];
  static getGraphics() {
    const graphics = Graphics.pool.pop() || new Graphics();
    graphics.disposed = false;
    return graphics;
  }
  constructor() { this.id = ++nextId; this._shapes = []; this.disposed = false; }
  get start() { return this._start || this.sourceGraphics?.start; }
  set start(v) { this._start = v; }
  get end() { return this._end || this.sourceGraphics?.end; }
  set end(v) { this._end = v; }
  dispose() { this.disposed = true; this._shapes = []; Graphics.pool.push(this); }
}
function definition(bytes = 1000) {
  const graphics = new Graphics();
  graphics.start = ['start'];
  graphics.end = ['end'];
  graphics.bytes = bytes;
  return graphics;
}
function instanceOf(source) {
  const graphics = new Graphics();
  graphics.sourceGraphics = source;
  return graphics;
}
function definitionBytes(graphics) {
  for (let g = graphics; g; g = g.sourceGraphics) if (g.bytes) return g.bytes;
  return 0;
}
// Each cache install wraps a fresh class so the checks stay independent.
const spriteClass = () => class MorphSprite {
  constructor(graphics) {
    this._graphics = graphics;
    this._ratio = undefined;
    this.builds = 0;
  }
  get graphics() { return this._graphics; }
  set graphics(value) { this._graphics = value; }
  setRatio(ratio) {
    const key = ratio * 0xffff | 0;
    if (this._ratio === key) return;
    if (ratio === -1) throw Error('bad morph');
    assert.ok(this.graphics.start && this.graphics.end, 'morph definition must resolve through sourceGraphics');
    this._ratio = key;
    this.builds++;
    this.graphics.value = key;
    const bytes = definitionBytes(this.graphics);
    this.graphics._shapes = [{ elements: { _positions: { attributesBuffer: { buffer: { byteLength: bytes } } } } }];
  }
  dispose() { this.disposed = true; }
};

{
  const MorphSprite = spriteClass();
  const stats = installMorphCache(MorphSprite, Graphics, { limit: 3, budget: 1e9 });
  const symbol = definition();
  const sprite = new MorphSprite(instanceOf(symbol));
  const base = sprite.graphics;
  sprite.setRatio(0);
  assert.notEqual(sprite.graphics, base, 'ratios build into cache-owned Graphics');
  sprite.setRatio(0.25);
  const quarter = sprite.graphics;
  sprite.setRatio(0.5);
  const half = sprite.graphics;
  sprite.setRatio(0.25);
  assert.equal(sprite.graphics, quarter);
  assert.equal(sprite.builds, 3, 'repeated ratio must reuse finished geometry');
  assert.equal(stats.hits, 1);
  assert.equal(stats.live, 3);
  assert.equal(stats.bytes, 3000);
  assert.equal(stats.top(1)[0].builds, 3);
  assert.ok(stats.buildMs >= 0);
  sprite.setRatio(0.75);
  assert.equal(stats.live, 3, 'limit bounds retained entries');
  assert.equal(stats.evictions, 1);
  assert.equal(half.disposed, false, 'the most recently used unused entry survives');
  sprite.setRatio(0.5);
  assert.equal(sprite.graphics, half, 'a retained entry is reused without a build');
  assert.equal(sprite.builds, 4);
  assert.equal(base.disposed, false, 'instance Graphics stay alive');
  assert.equal(symbol.disposed, false, 'morph definition stays alive');

  // A second instance of the same symbol shares the built ratio.
  const twin = new MorphSprite(instanceOf(symbol));
  twin.setRatio(0.5);
  assert.equal(twin.graphics, sprite.graphics, 'instances share one Graphics per ratio');
  assert.equal(twin.builds, 0, 'the shared ratio was not rebuilt');
  assert.equal(stats.shared, 1);
  sprite.dispose();
  assert.equal(sprite.graphics, base, 'disposal restores the instance Graphics');
  assert.equal(twin.graphics.disposed, false, 'a shared entry outlives one of its users');
  assert.equal(twin.graphics, half);
  twin.dispose();
  assert.equal(stats.live, 3, 'unused entries stay retained for the next loop');

  // Different symbols never share entries.
  const other = definition(500);
  const foreign = new MorphSprite(instanceOf(other));
  foreign.setRatio(0.5);
  assert.notEqual(foreign.graphics, half);
  foreign.dispose();

  // Replacing an instance's Graphics abandons the old state.
  const replaced = new MorphSprite(instanceOf(symbol));
  replaced.setRatio(0);
  replaced.setRatio(0.25);
  const replacement = instanceOf(symbol);
  replaced.graphics = replacement;
  replaced.setRatio(0.5);
  assert.notEqual(replaced.graphics, replacement);
  replaced.dispose();
  assert.equal(replaced.graphics, replacement, 'the new Graphics becomes the restore target');

  // Failed builds restore the previous Graphics and release the new one.
  const failing = new MorphSprite(instanceOf(symbol));
  failing.setRatio(0);
  const good = failing.graphics;
  assert.throws(() => failing.setRatio(-1), /bad morph/);
  assert.equal(failing.graphics, good);
  assert.equal(good.disposed, false);
  failing.dispose();

  // A recycled definition with different paths never serves old entries.
  const recycled = definition();
  const user = new MorphSprite(instanceOf(recycled));
  user.setRatio(0.5);
  user.dispose();
  recycled.start = ['other-start'];
  recycled.end = ['other-end'];
  const builds = stats.builds, live = stats.live;
  const fresh = new MorphSprite(instanceOf(recycled));
  fresh.setRatio(0.5);
  assert.equal(stats.builds, builds + 1, 'changed definition paths rebuild');
  assert.equal(fresh.builds, 1);
  assert.equal(stats.live, live, 'the orphaned entry was released for the rebuilt one');
  fresh.dispose();

  // Instances without a morph definition keep the original behaviour.
  const plain = new MorphSprite(new Graphics());
  plain.graphics.start = ['s'];
  plain.graphics.end = ['e'];
  const own = plain.graphics;
  plain.setRatio(0.5);
  assert.notEqual(plain.graphics, own, 'a definition on the instance itself is cached too');
  plain.dispose();
  const bare = new MorphSprite(new Graphics());
  assert.throws(() => bare.setRatio(0.5), /morph definition/);
}

{
  // The byte budget evicts unused entries before the count limit does.
  const MorphSprite = spriteClass();
  const stats = installMorphCache(MorphSprite, Graphics, { limit: 100, budget: 2500 });
  const sprite = new MorphSprite(instanceOf(definition(1000)));
  sprite.setRatio(0);
  sprite.setRatio(0.25);
  assert.equal(stats.bytes, 2000, 'two entries fit the budget');
  sprite.setRatio(0.5);
  assert.equal(stats.evictions, 1, 'the third entry evicts the oldest unused one');
  assert.equal(stats.bytes, 2000);
  sprite.setRatio(0.75);
  assert.equal(stats.evictions, 2);
  assert.equal(stats.bytes, 2000);
  sprite.dispose();
}

{
  // Quantized ratios collapse neighbouring tween steps into one entry.
  const MorphSprite = spriteClass();
  const stats = installMorphCache(MorphSprite, Graphics, { steps: 4 });
  const sprite = new MorphSprite(instanceOf(definition()));
  sprite.setRatio(0.2);
  sprite.setRatio(0.3);
  assert.equal(sprite.builds, 1, 'both ratios round to 0.25');
  assert.equal(sprite._ratio, 0.25 * 0xffff | 0);
  sprite.setRatio(0.6);
  assert.equal(sprite.builds, 2);
  assert.equal(stats.steps, 4);
  sprite.dispose();
}

console.log('Morph geometry cache: shared ratios, LRU limit, byte budget, replacement, failure, recycled definitions, quantization and disposal pass');
