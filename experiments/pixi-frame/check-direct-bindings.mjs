import assert from 'node:assert/strict';
import { createDirectObjectBindings } from './direct-object-bindings.mjs';

class ObjectStub {
  constructor() { this._children=[];this.nativeCalls=0;this.transform={colorTransform:{_rawData:new Float32Array([1,1,1,1,0,0,0,0])}}; }
  _invalidateHierarchicalProperty() { this.nativeCalls++; }
  invalidate() { this.nativeCalls++; }
}
const original=ObjectStub.prototype._invalidateHierarchicalProperty;
const node=new ObjectStub(), stats={unchangedColorUpdates:0,translationReuses:0,localMaskUpdates:0};
const records=new Map();let changes=[];
const bindings=createDirectObjectBindings({
  record(n){const r={outer:{},node:n};records.set(n,r);return r;},
  update(n,r){r.transform=[1,0,0,1,0,0];r.is3D=false;},
  changed(r,descendants=false,content=true){changes.push([r,descendants,content]);r.selfDirty||=content;r.descendantsDirty||=descendants;},
  stats,
});
try {
  bindings.own(node);changes=[];
  node._invalidateHierarchicalProperty(16);
  assert.equal(changes.length,0);assert.equal(stats.unchangedColorUpdates,1);assert.equal(node.nativeCalls,1);
  // Each channel participates in exact comparison; in-place arrays are not aliases.
  for(let i=0;i<8;i++) {
    changes=[];node.transform.colorTransform._rawData[i]+=0.125;
    node._invalidateHierarchicalProperty(16);
    assert.equal(changes.length,1);assert.deepEqual(changes[0].slice(1),[true,true]);
    node._invalidateHierarchicalProperty(16);assert.equal(changes.length,1);
  }
  // Identical replacement arrays are also no-ops.
  changes=[];node.transform.colorTransform._rawData=node.transform.colorTransform._rawData.slice();
  node._invalidateHierarchicalProperty(16);assert.equal(changes.length,0);
  // Never clear queued paint or geometry work when a later notification repeats it.
  const r=records.get(node);r.selfDirty=r.descendantsDirty=false;
  node.invalidate();node._invalidateHierarchicalProperty(16);assert.equal(r.selfDirty,true);
  r.selfDirty=r.descendantsDirty=false;node.transform.colorTransform._rawData[3]=0.375;
  node._invalidateHierarchicalProperty(16);node._invalidateHierarchicalProperty(16);
  assert.equal(r.selfDirty,true);assert.equal(r.descendantsDirty,true);
  // Unrelated transform notifications cannot consume a pending raw color edit.
  changes=[];node.transform.colorTransform._rawData[4]=128;
  node._invalidateHierarchicalProperty(32);const before=changes.length;
  node._invalidateHierarchicalProperty(16);assert.equal(changes.length,before+1);
  // Combined/full notifications always retain their broader invalidation.
  for(const flags of [48,255]){changes=[];node._invalidateHierarchicalProperty(flags);assert.equal(changes.length,1);assert.equal(changes[0][1],true);}
  // Unknown color layouts and NaN take the conservative path.
  node.transform.colorTransform._rawData[0]=NaN;
  for(let i=0;i<2;i++){changes=[];node._invalidateHierarchicalProperty(16);assert.equal(changes.length,1);}
  node.transform.colorTransform=null;changes=[];node._invalidateHierarchicalProperty(16);assert.equal(changes.length,1);
} finally { bindings.destroy(); }
assert.equal(ObjectStub.prototype._invalidateHierarchicalProperty,original);
assert.equal(bindings.get(node),undefined);
console.log('Direct color notifications: exact snapshots, native calls, pending work, combined flags and cleanup passed.');
