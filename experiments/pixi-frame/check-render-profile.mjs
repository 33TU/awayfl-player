import assert from 'node:assert/strict';
import { createRenderProfiler } from './render-profile.mjs';
const oldPerformance=globalThis.performance;
let now=0;
Object.defineProperty(globalThis,'performance',{value:{now:()=>now},configurable:true});
try {
 const gl={getExtension:()=>null,isContextLost:()=>false,
  drawElements(){},drawArrays(){},drawElementsInstanced(){},drawArraysInstanced(){},
  bufferData(){},bufferSubData(){},blitFramebuffer(){}};
 const renderer={gl,render(){now+=7;},renderGroup:{_buildInstructions(){},_updateRenderGroups(){}},renderPipes:{batch:{upload(){},execute(){}}}};
 const stats={syncMs:3,renderSize:[100,100],mode:'direct-objects',
  configuration:{nativeGraphics:true,cacheScenery:true},sceneryCandidates:2,sceneryWarming:2};
 let reused=false,detailed=false;
 function section(name, run) { const end=profiler.section(name);try{return run();}finally{end?.();} }
 function bindings(){section('bindings',()=>{now+=0.25;section('bindings',()=>{now+=0.25;});now+=0.5;});}
 const player={frameRate:24,isPaused:false,
  _mouseManager:{fireMouseEvents(){now+=1;}},
  _avmHandler:{enterFrame(){now+=3;bindings();}},
  _renderer:{render(){section('syncSetupMs',()=>{now+=1;});section('syncVisitMs',()=>{now+=1;bindings();if(detailed)section('syncNativeMs',()=>{now+=2;section('syncShapeMs',()=>{now+=3;});});});if(!reused)renderer.render();section('adapterCleanupMs',()=>{now+=1;});}},
  showNextFrame(){this._mouseManager.fireMouseEvents();this._avmHandler.enterFrame();this._renderer.render();now+=2;return 42;}};
 const originalInput=player._mouseManager.fireMouseEvents,originalTimeline=player._avmHandler.enterFrame;
 const originalTick=player.showNextFrame,originalAdapter=player._renderer.render,originalRender=renderer.render,originalDraw=gl.drawElements;
 const profiler=createRenderProfiler(renderer,stats,undefined,player);
 const pending=profiler.sample(2);
 assert.equal(player.showNextFrame(),42);
 now=50;reused=true;player.showNextFrame();
 now=120;reused=false;player.showNextFrame();
 const result=await pending;
 assert.equal(result.reason,'complete');assert.equal(result.frames.length,2);
 assert.deepEqual(result.pickBounds,{enabled:false,checks:0,skips:0,ms:0});
 assert.equal(result.frameTiming.ticks,3);assert.equal(result.frameTiming.ticksWithoutDraw,1);
 assert.equal(result.frameTiming.observedFPS,1000/60);
 assert.deepEqual(result.frameTiming.median,{frameWorkMs:18,runtimeMs:7,adapterMs:11,frameIntervalMs:60});
 assert.equal(result.frameTiming.p95.frameIntervalMs,70);
 assert.equal(result.median.syncMs,3);assert.equal(result.median.renderMs,7);
 assert.equal(result.median.frameWorkMs,18);assert.equal(result.median.runtimeMs,7);assert.equal(result.median.adapterMs,11);
 assert.equal(result.frames[0].frameIntervalMs,null);assert.equal(result.frames[1].frameIntervalMs,70);
 function restored(){assert.equal(profiler.section('bindings'),undefined);assert.equal(player._mouseManager.fireMouseEvents,originalInput);assert.equal(player._avmHandler.enterFrame,originalTimeline);assert.equal(player.showNextFrame,originalTick);assert.equal(player._renderer.render,originalAdapter);assert.equal(renderer.render,originalRender);assert.equal(gl.drawElements,originalDraw);}
 assert.equal(result.cpu.basis,'native-ticks');
 assert.equal(result.cpu.mean.pixiRenderMs,14/3);
 assert.equal(result.cpu.mean.inputMs,1);
 assert.deepEqual(result.cpu.median,{inputMs:1,inputPickMs:0,inputTraverseMs:0,inputCollectMs:0,inputCollisionMs:0,timelineMs:3,timelineAdvanceMs:0,timelineBroadcastMs:0,runtimeBindingsMs:1,runtimeOtherMs:2,
  syncSetupMs:1,syncVisitMs:1,syncNativeMs:0,syncShapeMs:0,syncMasksMs:0,syncRetireMs:0,syncSceneryMs:0,syncBindingsMs:1,
  pixiRenderMs:7,adapterCleanupMs:1,adapterOtherMs:0});
 for(const frame of result.frames)assert.equal(Object.values(frame.cpu).reduce((a,b)=>a+b,0),frame.frameWorkMs);
 restored();
 // A manual draw must not invent a native tick, runtime timing or FPS.
 const manual=profiler.sample(1);player._renderer.render();const m=await manual;
 assert.equal(m.frameTiming.ticks,0);assert.equal(m.frameTiming.observedFPS,null);
 assert.equal(m.cpu.basis,'manual-draws');assert.equal(m.cpu.median.timelineMs,0);assert.equal(m.cpu.median.syncBindingsMs,1);assert.equal(Object.values(m.frames[0].cpu).reduce((a,b)=>a+b,0),11);
 assert.equal(m.median.frameWorkMs,null);assert.equal(m.median.runtimeMs,null);assert.equal(m.median.adapterMs,11);restored();
 // Traversal invokes conversion callbacks synchronously. Their time belongs
 // only to syncShapeMs, not to both native preparation and syncVisitMs.
 detailed=true;const nested=profiler.sample(1);
 stats.configuration.nativeGraphics=false;stats.sceneryWarming=0;stats.sceneryCaches=2;
 player._renderer.render();const n=await nested;detailed=false;
 assert.equal(n.cpu.median.syncVisitMs,1);assert.equal(n.cpu.median.syncNativeMs,2);assert.equal(n.cpu.median.syncShapeMs,3);
 assert.equal(Object.values(n.frames[0].cpu).reduce((a,b)=>a+b,0),16);
 assert.deepEqual(n.configuration,{mode:'direct-objects',nativeGraphics:true,cacheScenery:true});
 assert.equal(n.scenery.start.sceneryWarming,2);assert.equal(n.scenery.start.sceneryCaches,0);
 assert.equal(n.scenery.end.sceneryWarming,0);assert.equal(n.scenery.end.sceneryCaches,2);restored();
 const cancelled=profiler.sample(1);profiler.stop();assert.equal((await cancelled).reason,'renderer stopped');restored();
 // Exceptions preserve the original failure and cleanup remains available.
 player.showNextFrame=function(){section('timelineMs',()=>{now+=1;throw Error('native frame failure');});};const throwing=player.showNextFrame;
 const failure=profiler.sample(1);assert.throws(()=>player.showNextFrame(),/native frame failure/);profiler.stop();await failure;
 assert.equal(player.showNextFrame,throwing);assert.equal(player._renderer.render,originalAdapter);
 // Cancellation must not overwrite an independently replaced hook.
 player.showNextFrame=originalTick;const replaced=profiler.sample(1);const replacement=()=>{};player.showNextFrame=replacement;profiler.stop();await replaced;assert.equal(player.showNextFrame,replacement);
 // Count each submitted filter pass and its bounded viewport; the numbers are
 // workload estimates, so GPU milliseconds remain a whole-frame measurement.
 class TestBlurFilter {}
 const drawFilter=()=>{gl.drawElements(gl.TRIANGLES,6);now+=1;};
 renderer.filter={_setupBindGroupsAndRender:drawFilter,
  _filterGlobalUniforms:{uniforms:{uOutputFrame:[0,0,20,10]}}};
 renderer.renderTarget={viewport:{width:80,height:40},renderTarget:{resolution:2}};
 renderer.render=()=>{renderer.filter._setupBindGroupsAndRender(new TestBlurFilter());now+=7;};
 const effectProfiler=createRenderProfiler(renderer,stats,undefined,player);
 const effectSample=effectProfiler.sample(1);player._renderer.render();const effects=await effectSample;
 assert.equal(effects.median.filterPasses,1);
 assert.equal(effects.median.filterTargetPixels,3200);
 assert.equal(effects.median.filterQuadPixels,800);
 assert.deepEqual(effects.effects.map(({name,passes,targetPixels,quadPixels,draws})=>({name,passes,targetPixels,quadPixels,draws})),
  [{name:'TestBlurFilter',passes:1,targetPixels:3200,quadPixels:800,draws:1}]);
 assert.equal(renderer.filter._setupBindGroupsAndRender,drawFilter);
 renderer.render=originalRender;
 // Nested picker and AVM2 stage hooks partition the runtime tick without
 // double-counting their parent input/timeline sections.
 const picker={getViewCollision(){this.traverse();this._collectEntities();this._getPickingCollision();now+=2;},
  traverse(){now+=3;},_collectEntities(){now+=4;},_getPickingCollision(){now+=5;}};
 const stage={adaptee:{advanceFrame(){now+=4;}},dispatchStaticBroadCastEvent(){now+=1;}};
 player._mousePicker=picker;
 player._avmHandler._playerglobal={_stage:stage};
 player._mouseManager.fireMouseEvents=()=>{picker.getViewCollision();now+=1;};
 player._avmHandler.enterFrame=()=>{stage.adaptee.advanceFrame();stage.dispatchStaticBroadCastEvent();now+=2;};
 player.showNextFrame=function(){this._mouseManager.fireMouseEvents();this._avmHandler.enterFrame();this._renderer.render();};
 const originalPick=picker.getViewCollision,originalTraverse=picker.traverse;
 const originalAdvance=stage.adaptee.advanceFrame;
 const originalBroadcast=stage.dispatchStaticBroadCastEvent;
 const runtimeProfiler=createRenderProfiler(renderer,stats,undefined,player);
 const runtimeSample=runtimeProfiler.sample(1);player.showNextFrame();const runtime=await runtimeSample;
 assert.equal(runtime.cpu.median.inputPickMs,2);
 assert.equal(runtime.cpu.median.inputTraverseMs,3);
 assert.equal(runtime.cpu.median.inputCollectMs,4);
 assert.equal(runtime.cpu.median.inputCollisionMs,5);
 assert.equal(runtime.cpu.median.inputMs,1);
 assert.equal(runtime.cpu.median.timelineAdvanceMs,4);
 assert.equal(runtime.cpu.median.timelineBroadcastMs,1);
 assert.equal(runtime.cpu.median.timelineMs,2);
 assert.equal(picker.getViewCollision,originalPick);
 assert.equal(picker.traverse,originalTraverse);
 assert.equal(stage.adaptee.advanceFrame,originalAdvance);
 assert.equal(stage.dispatchStaticBroadCastEvent,originalBroadcast);
 stats.configuration.pixiPickBounds=true;
 picker.getViewCollision=()=>{stats.pixiPickBoundsChecks=3;stats.pixiPickBoundsSkips=2;stats.pixiPickBoundsMs=1.5;};
 const boundsProfiler=createRenderProfiler(renderer,stats,undefined,player);
 const boundsSample=boundsProfiler.sample(1);player.showNextFrame();const boundsResult=await boundsSample;
 assert.deepEqual(boundsResult.pickBounds,{enabled:true,checks:3,skips:2,ms:1.5});
 stats.pixiPickBoundsChecks=30;stats.pixiPickBoundsSkips=20;stats.pixiPickBoundsMs=15;
 assert.deepEqual(boundsResult.pickBounds,{enabled:true,checks:3,skips:2,ms:1.5},
  'post-sample ticks do not extend the bounded profile');
 stats.configuration.pixiPickBounds=false;
 class TreePicker {
  enterNode(node){return node.container.assetType !== 'hidden';}
  getViewCollision(){this.enterNode({container:{assetType:'clip'},_numChildNodes:2});
   this.enterNode({container:{assetType:'shape'},_numChildNodes:0});
   this.enterNode({container:{assetType:'hidden'},_numChildNodes:0});}
 }
 player._mousePicker=new TreePicker();
 player._mouseManager.fireMouseEvents=()=>player._mousePicker.getViewCollision();
 const originalEnter=TreePicker.prototype.enterNode;
 const treeProfiler=createRenderProfiler(renderer,stats,undefined,player);
 const treeSample=treeProfiler.sample(1,{pickTree:true});player.showNextFrame();const tree=await treeSample;
 assert.deepEqual(tree.pickTree,{visited:3,accepted:2,rejected:1,leaves:2,containers:1,
  pickObjects:0,types:[{type:'clip',count:1},{type:'shape',count:1},{type:'hidden',count:1}]});
 assert.equal(TreePicker.prototype.enterNode,originalEnter);
 const plainSample=treeProfiler.sample(1);player.showNextFrame();const plain=await plainSample;
 assert.equal(plain.pickTree,null);
 assert.equal(TreePicker.prototype.enterNode,originalEnter);
 console.log('Frame timing, reused frames, percentiles, manual draws and hook cleanup passed.');
} finally {Object.defineProperty(globalThis,'performance',{value:oldPerformance,configurable:true});}
