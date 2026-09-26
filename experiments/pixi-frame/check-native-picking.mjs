import assert from 'node:assert/strict';
import { createNativePicking } from './native-picking.mjs';

class Box { x=0; y=0; z=0; width=0; height=0; depth=0; }
const picking = createNativePicking(Box);
const elements = { hitTestPoint(node, x, y, z, box, count, offset) {
  return x === 99 || !!count || !!offset;
}, getBoxBounds() { return { native: true }; } };
const original = elements.hitTestPoint;
const originalBounds = elements.getBoxBounds;
const first = { bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  containsPoint({ x, y }) { return x >= 0 && x < 10 && y >= 0 && y < 10; } };
const second = { bounds: first.bounds, containsPoint() { return false; } };
assert.ok(picking.bind(elements, first));
assert.equal(elements.hitTestPoint(null, 5, 5), true);
assert.equal(elements.hitTestPoint(null, 20, 5), false);
assert.deepEqual(elements.getBoxBounds(),
  Object.assign(new Box(), {x:0,y:0,z:0,width:10,height:10,depth:0}));
const matrix = { _rawData: new Float32Array([2,0,0,0,0,3,0,0,0,0,1,0,5,7,0,1]) };
assert.deepEqual(elements.getBoxBounds(null,true,matrix),
  Object.assign(new Box(), {x:5,y:7,z:0,width:20,height:30,depth:0}));
const target=Object.assign(new Box(), {x:-5,y:-5,width:2,height:2});
assert.equal(elements.getBoxBounds(null,true,null,null,target),target);
assert.deepEqual([target.x,target.y,target.width,target.height],[-5,-5,15,15]);
assert.equal(elements.hitTestPoint(null, 99, 5, 0, null, 1), true,
  'partial triangle ranges retain native picking');
assert.deepEqual(elements.getBoxBounds(null,true,null,null,null,1),{native:true},
  'partial ranges retain native bounds');
assert.ok(picking.bind(elements, first));
picking.release(elements, first);
assert.equal(elements.hitTestPoint(null, 5, 5), true,
  'shared path keeps the hook until its last user retires');
assert.ok(picking.bind(elements, second));
assert.equal(elements.hitTestPoint(null, 99, 5), true,
  'different contexts sharing one element fall back to native picking');
assert.deepEqual(elements.getBoxBounds(),{native:true},
  'different contexts sharing one element fall back to native bounds');
picking.release(elements, second);
assert.equal(elements.hitTestPoint(null, 5, 5), true);
picking.release(elements, first);
assert.equal(elements.hitTestPoint, original);
assert.equal(elements.getBoxBounds, originalBounds);
assert.ok(picking.bind(elements, first));
picking.destroy();
assert.equal(elements.hitTestPoint, original, 'switching to AwayFL restores the original hit test');
assert.equal(elements.getBoxBounds, originalBounds, 'switching to AwayFL restores native bounds');
console.log('Passed Pixi path picking, shared elements, partial ranges and AwayFL restoration.');
