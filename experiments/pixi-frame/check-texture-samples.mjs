import assert from 'node:assert/strict';
import { createAssetTracker } from './display-list-data.mjs';
import { constantTextureOffset, createTextureSamples } from './texture-samples.mjs';
const listeners = new Set(), changes = [];
const prototype = { invalidateGPU() {} };
const image = Object.assign(Object.create(prototype), {
  width: 2, height: 1, unpackPMA: false, _data: new Uint8Array([1,2,3,255,4,5,6,255]),
  addAbstraction(r) { listeners.add(r); }, removeAbstraction(r) { listeners.delete(r); },
});
const tracker = createAssetTracker(owner => changes.push(owner));
const samples = createTextureSamples(tracker);
const a = {}, b = {}, whole = {};
function own(owner, offset) {
  tracker.beginOwner(owner);
  tracker.version(image, 'invalidateGPU', '_imageDataDirty', offset === null);
  const version = offset === null ? null : samples.version(image, offset);
  tracker.endOwner(); return version;
}
const before = own(a, 0); own(b, 4); own(whole, null);
const uv = {a:0,b:0,c:0,d:0,tx:0.25,ty:0.5};
assert.equal(constantTextureOffset(image,uv),0);
assert.equal(constantTextureOffset(image,{...uv,tx:0.75}),4);
for (const u of [{...uv,a:1},{...uv,tx:0.5},{...uv,tx:-0.25},{...uv,tx:1.25}])
  assert.equal(constantTextureOffset(image,u),null);
assert.equal(constantTextureOffset(image,uv,true),null);
// Repeated writes to another texel don't wake A or change its paint revision.
image._data[4]=99;image.invalidateGPU();image.invalidateGPU();samples.flush();
assert.deepEqual(changes,[whole,whole,b]);assert.equal(own(a,0),before);
changes.length=0;image._data[0]=22;image.invalidateGPU();samples.flush();
assert.deepEqual(changes,[whole,a]);assert.notEqual(own(a,0),before);
// Premultiplication, GPU-only changes and resize affect all sampled consumers.
for (const change of [()=>image.unpackPMA=true,()=>image._imageDataDirty=true,
  ()=>image._imageDataDirty=false,()=>image.width=4,()=>image.isDisposed=true,
  ()=>image._initalFillColor=0xff00ff,()=>image._lazySymbol={},
  ()=>image._alphaChannel=new Uint8Array([70,90])]) {
  changes.length=0;change();image.invalidateGPU();samples.flush();
  assert.ok(changes.includes(a));assert.ok(changes.includes(b));
}
// Reverting a CPU edit before flush doesn't change sampled appearance.
changes.length=0;const old=image._data[0];image._data[0]=3;image.invalidateGPU();
image._data[0]=old;image.invalidateGPU();samples.flush();assert.deepEqual(changes,[whole,whole]);
// Whole-image and sampled dependencies on one owner are both respected.
tracker.beginOwner(a);tracker.version(image);samples.version(image,0);tracker.endOwner();
changes.length=0;image._data[4]++;image.invalidateGPU();samples.flush();assert.ok(changes.includes(a));
for (const owner of [a,b,whole]) tracker.releaseOwner(owner);
samples.sweep();assert.equal(samples.retained(image),false);
tracker.epoch=100;tracker.sweep();assert.equal(listeners.size,0);
assert.equal(Object.hasOwn(image,'invalidateGPU'),false);
samples.destroy();tracker.destroy();
console.log('Sampled texture dependencies, real edits, GPU changes and cleanup passed.');
