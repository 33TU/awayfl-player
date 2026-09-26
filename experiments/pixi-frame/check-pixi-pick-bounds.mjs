import assert from 'node:assert/strict';
import { installPixiPickBounds } from './pixi-pick-bounds.mjs';

class Picker {
  constructor(view) { this.node = {view}; this.visited = []; }
  getViewCollision(x, y) { return this.getTraverser(this.candidate); }
  getTraverser(node) { this.visited.push(node); return this; }
}
const view = {width:100,height:100};
const picker = new Picker(view);
const pointer = {down:{type:'down'},up:{type:'up'},queuedEvents:[]};
const player = {_mousePicker:picker,_mouseManager:{_pointerDataArray:{0:pointer}}};
const container = {pickObject:null};
const candidate = {container,_numChildNodes:4,isDragEntity:()=>false};
picker.candidate = candidate;
const outer = {parent:{},visible:true,getBounds:()=>({x:25,y:25,width:20,height:20})};
const records = new Map([[container,{outer}]]);
const stats = {configuration:{}};
const originalCollision = picker.getViewCollision;
const originalTraverser = Picker.prototype.getTraverser;
const restore = installPixiPickBounds(player,records,stats,{width:200,height:200});
assert.equal(stats.configuration.pixiPickBounds,true);
assert.equal(picker.getViewCollision(80,80),null);
assert.equal(stats.pixiPickBoundsSkips,1);
assert.equal(picker.getViewCollision(20,20),picker);
assert.equal(picker.visited.length,1);
pointer.queuedEvents.push({type:'down'});
assert.equal(picker.getViewCollision(80,80),picker,'press uses exact native picking');
pointer.queuedEvents.length=0;
container.pickObject={};
assert.equal(picker.getViewCollision(80,80),picker,'custom hit area bypasses visual bounds');
container.pickObject=null;
candidate._numChildNodes=1;
assert.equal(picker.getViewCollision(80,80),picker,'small branches retain native behavior');
candidate._numChildNodes=4;
candidate.isDragEntity=()=>true;
assert.equal(picker.getViewCollision(80,80),picker,'dragging retains native behavior');
restore();
assert.equal(picker.getViewCollision,originalCollision);
assert.equal(Picker.prototype.getTraverser,originalTraverser);
assert.equal(stats.configuration.pixiPickBounds,false);
console.log('Pixi pick bounds cull distant branches and preserve native fallbacks.');
