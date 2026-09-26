import assert from 'node:assert/strict';
import { planUploadRanges, installRangeUploads } from './upload-ranges.mjs';
assert.deepEqual(planUploadRanges([[20,30],[0,10],[8,22]],0),[[0,30]]);
assert.deepEqual(planUploadRanges([[0,10],[10000,10010]]),[[0,10],[10000,10010]]);
assert.deepEqual(planUploadRanges([[0,10],[20,30]]),[[0,30]]);
assert.deepEqual(planUploadRanges([[0,90],[100,190]],0),[[0,190]]);
assert.deepEqual(planUploadRanges([]),[]);
const scattered=Array.from({length:40},(_,i)=>[i*i*10000,i*i*10000+10]);
const bounded=planUploadRanges(scattered);
assert.ok(bounded.length<=8);
for(const [a,b] of scattered)assert.ok(bounded.some(([x,y])=>a>=x&&b<=y));
// Exercise deferred GL consumption, replacement revisions, storage growth,
// and GPU-buffer recreation without needing a browser or asynchronous timers.
const memory=new Float32Array(100),calls=[];
const gpu={updateID:1,byteLength:400,type:1,buffer:{}};
const buffer={data:new Float32Array(100),_updateID:1,_gpuData:{7:gpu},_updateOffset:0,_updateSize:400};
let originals=0,touches=0;
const system={
 _gl:{bindBuffer(){},bufferSubData(type,offset,data,start,count){calls.push([offset,count*4]);memory.set(data.subarray(start,start+count),offset/4);}},
 getGlBuffer(b){touches++;return b._gpuData[7];},
 updateBuffer(b){originals++;memory.set(b.data.subarray(0,100));b._gpuData[7].updateID=b._updateID;return b._gpuData[7];}
};
const original=system.updateBuffer,ranges=installRangeUploads({uid:7,buffer:system});
buffer.data[1]=12;buffer.data[90]=34;buffer._updateID++;
ranges.queue(buffer,[[1,2],[90,91]]);system.updateBuffer(buffer);
assert.deepEqual(calls,[[4,4],[360,4]]);assert.equal(memory[1],12);assert.equal(memory[90],34);assert.equal(originals,0);assert.equal(touches,1);
// An intervening edit supersedes a queued ticket; no earlier edit gets lost.
buffer.data[2]=56;buffer._updateID++;ranges.queue(buffer,[[2,3],[90,91]]);
buffer.data[3]=78;buffer._updateID++;system.updateBuffer(buffer);
assert.equal(originals,1);assert.equal(memory[2],56);assert.equal(memory[3],78);
buffer._updateID++;ranges.queue(buffer,[[1,2],[90,91]]);buffer.data=new Float32Array(200);system.updateBuffer(buffer);assert.equal(originals,2);
buffer._updateID++;ranges.queue(buffer,[[1,2],[90,91]]);buffer._gpuData[7]={...gpu,updateID:0};system.updateBuffer(buffer);assert.equal(originals,3);
buffer._updateID++;ranges.queue(buffer,[[1,2],[90,91]]);ranges.clear(buffer);system.updateBuffer(buffer);assert.equal(originals,4);
buffer._gpuData[7].byteLength=0;buffer._updateID++;ranges.queue(buffer,[[1,2],[90,91]]);system.updateBuffer(buffer);assert.equal(originals,5);
buffer._gpuData[7].byteLength=800;buffer._updateID++;ranges.queue(buffer,[[1,2],[90,91]]);buffer._gpuData[7].updateID++;system.updateBuffer(buffer);assert.equal(originals,6);
ranges.restore();assert.equal(system.updateBuffer,original);
console.log('Upload-range planning and deferred revision checks passed.');
