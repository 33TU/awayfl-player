import assert from 'node:assert/strict';
import { vectorInputs, sameVectorInputs } from './vector-inputs.mjs';
const buffer=()=>({data:new Float32Array(6),_updateID:1});
const e={geometry:{attributes:Object.fromEntries(['aPosition','aUV','aCurve'].map(k=>[k,{buffer:buffer()}]))},renderable:{flashRect:{width:1,height:1,x:0,y:0},flashRadial:0,flashMultiply:new Float32Array([1,1,1,1]),flashOffset:new Float32Array(4)},transform:{a:1,b:0,c:0,d:1,tx:0,ty:0},color:0xffffffff,roundPixels:0,attributeOffset:0,attributeSize:3,texture:{textureMatrix:{_updateID:1}}};
const target=new Float32Array(66),baseline=vectorInputs(e,target,0,0);
const read=()=>vectorInputs(e,target,0,0);
assert.ok(sameVectorInputs(baseline,read()));
function change(object,key,value){const old=object[key];object[key]=value;assert.equal(sameVectorInputs(baseline,read()),false,key);object[key]=old;assert.ok(sameVectorInputs(baseline,read()));}
for(const k of ['a','b','c','d','tx','ty'])change(e.transform,k,e.transform[k]+1);
for(const k of ['color','roundPixels','attributeOffset','attributeSize'])change(e,k,e[k]+1);
for(const k of ['width','height','x','y'])change(e.renderable.flashRect,k,e.renderable.flashRect[k]+1);
for(const k of ['flashMultiply','flashOffset'])for(let i=0;i<4;i++)change(e.renderable[k],i,e.renderable[k][i]+1);
change(e.renderable,'flashRadial',1);change(e.texture.textureMatrix,'_updateID',2);
change(e.texture,'textureMatrix',{_updateID:1});
for(const k of ['aPosition','aUV','aCurve']){
 const b=e.geometry.attributes[k].buffer;change(b,'_updateID',2);change(b,'data',new Float32Array(6));change(e.geometry.attributes[k],'buffer',buffer());
}
assert.equal(sameVectorInputs(baseline,vectorInputs(e,target,22,0)),false);
assert.equal(sameVectorInputs(baseline,vectorInputs(e,target,0,1)),false);
assert.equal(sameVectorInputs(baseline,vectorInputs(e,new Float32Array(66),0,0)),false);
assert.equal(sameVectorInputs(undefined,baseline),false);
// Equal-valued shader arrays do not force repacking merely because allocated anew.
e.renderable.flashMultiply=[1,1,1,1];e.renderable.flashOffset=[0,0,0,0];e.renderable.flashRect=null;
assert.ok(sameVectorInputs(baseline,read()));
const scratch=[];assert.equal(vectorInputs(e,target,0,0,scratch),scratch);
console.log('Vector input changes, in-place buffer revisions and batch relocation checks passed.');
