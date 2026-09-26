import assert from 'node:assert/strict';
import { installCachedPickBounds } from '../../src/graphics/cached-pick-bounds.mjs';

class Asset {
  guards = new Set();
  addAbstraction(guard) { this.guards.add(guard); }
  removeAbstraction(guard) { this.guards.delete(guard); }
  invalidate() { for (const guard of [...this.guards]) guard.onInvalidate(); }
  clear() { for (const guard of [...this.guards]) guard.onClear(); }
}
class Box { x=0; y=0; z=0; width=0; height=0; depth=0; }
class TriangleElements extends Asset {
  positions = { attributesBuffer: new Asset() };
  indices = { attributesBuffer: new Asset() };
  _numElements = 3;
  _numVertices = 3;
  calls = 0;
  value = 5;
  getBoxBounds(node, strokeFlag, matrix, cache, target, count, offset) {
    this.calls++;
    if (matrix || target || count || offset) return { fallback: true };
    const box = cache || new Box();
    box.x = this.value; box.y = this.value + 1;
    box.width = 10; box.height = 11;
    return box;
  }
}

const stats = installCachedPickBounds(TriangleElements, Box);
const elements = new TriangleElements();
assert.equal(elements.getBoxBounds().x, 5);
const reused = new Box();
assert.equal(elements.getBoxBounds(null, true, null, reused), reused);
assert.equal(elements.calls, 1, 'unchanged geometry must skip the vertex scan');
assert.equal(stats.hits, 1);
elements.value = 9;
elements.positions.attributesBuffer.invalidate();
assert.equal(elements.getBoxBounds().x, 9);
assert.equal(elements.calls, 2, 'position edits must invalidate cached bounds');
elements.value = 12;
elements.indices.attributesBuffer.invalidate();
assert.equal(elements.getBoxBounds().x, 12);
assert.equal(elements.calls, 3, 'index edits must invalidate cached bounds');
assert.deepEqual(elements.getBoxBounds(null, true, {}), { fallback: true });
assert.deepEqual(elements.getBoxBounds(null, true, null, null, {}, 0, 0), { fallback: true });
assert.deepEqual(elements.getBoxBounds(null, true, null, null, null, 1), { fallback: true });
elements.positions.attributesBuffer.clear();
assert.equal(elements.guards.size, 0, 'clearing a buffer detaches all hooks');
assert.equal(elements.getBoxBounds().x, 12);
assert.equal(elements.calls, 7);
const newBuffer = new Asset();
elements.positions.attributesBuffer = newBuffer;
assert.equal(elements.getBoxBounds().x, 12);
assert.equal(elements.calls, 8, 'replacing a buffer must not reuse old bounds');
console.log('Cached triangle picking bounds: reuse, mutation and fallback pass');
