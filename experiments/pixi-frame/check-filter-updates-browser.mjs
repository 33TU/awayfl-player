// Browser regression: uniform updates must match freshly constructed filters,
// preserve effect attachments, and invalidate retained output and padding.
import { Container, Graphics, WebGLRenderer } from "pixi.js";
import { describeFilter, createFilter, filterProgramKey, updateFilter, destroyFilter } from "./display-list-filters.mjs";
import { RetainedEffects } from "./display-list-effect-cache.mjs";

export async function checkFilterUpdates() {
  const renderer = new WebGLRenderer();
  await renderer.init({ width: 192, height: 128, antialias: true, backgroundAlpha: 0 });
  const scene = new Container();
  const shape = new Graphics().rect(75, 45, 35, 26).fill({color:0x38bde5,alpha:0.8});
  scene.addChild(shape);
  const cases = [
    ["blur", {filterName:"blur",blurX:3,blurY:7}, {filterName:"blur",blurX:28,blurY:10,quality:2}],
    ["zero blur", {filterName:"blur",blurX:14,blurY:8}, {filterName:"blur",blurX:0,blurY:0}],
    ["asymmetric shadow", {filterName:"dropShadow",blurX:2,blurY:5,distance:3}, {filterName:"dropShadow",blurX:24,blurY:9,distance:-11,angle:130,color:0xff8040,alpha:0.7,quality:2}],
    ["shadow only", {filterName:"dropShadow",blurX:6,blurY:2}, {filterName:"dropShadow",blurX:3,blurY:13,hideObject:true,angle:210,distance:8}],
    ["outline", {filterName:"glow",strength:10,blurX:2,blurY:2}, {filterName:"glow",strength:10,blurX:5,blurY:5,color:0xff7700,alpha:0.6,knockout:true}],
    ["glow uniforms", {filterName:"glow",blurX:8,blurY:8}, {filterName:"glow",blurX:8,blurY:8,color:0xe54488,alpha:0.7,strength:3,inner:true}],
    ["bevel", {filterName:"bevel",distance:2}, {filterName:"bevel",distance:6,angle:190,highlightColor:0xaaee77,shadowColor:0xee2244,strength:0.5}],
    ["mixed chain", [{filterName:"blur",blurX:4,blurY:2},{filterName:"dropShadow",blurX:7,blurY:3,distance:4}], [{filterName:"blur",blurX:19,blurY:7},{filterName:"dropShadow",blurX:3,blurY:17,distance:8,angle:190,color:0x66ee44}]],
    ["text outline", {filterName:"glow",strength:10,blurX:2,blurY:2}, {filterName:"glow",strength:10,blurX:5,blurY:4,color:0xff7700,alpha:0.6}],
    ["matrix", {filterName:"colorMatrix",matrix:[1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0]}, {filterName:"colorMatrix",matrix:[0.5,0,0,0,35,0,0.8,0,0,5,0,0,0.2,0,10,0,0,0,0.6,0]}],
  ];
  const stats = { effectCachePixels:0,effectCacheHits:0,effectCacheBuilds:0,effectPasses:0 };
  function pixels() {
    renderer.render({container:scene});
    const a=new Uint8Array(192*128*4);
    renderer.gl.readPixels(0,0,192,128,renderer.gl.RGBA,renderer.gl.UNSIGNED_BYTE,a);
    return a;
  }
  const results=[];
  try {
    for(const [name,from,to] of cases) for(const cached of [false,true]) {
      const a=[from].flat().map(f=>describeFilter(f)),b=[to].flat().map(f=>describeFilter(f));
      if(JSON.stringify(a.map(filterProgramKey))!==JSON.stringify(b.map(filterProgramKey))) throw Error("Unexpected shader change: "+name);
      const filters=a.map(createFilter);
      if(name==='text outline')for(const f of filters)f.antialias='on';
      const wrapper=cached?new RetainedEffects(filters,stats):null;
      shape.filters=cached?[wrapper]:filters;pixels();pixels(); // populate retained output
      const builds=renderer.renderGroup._buildInstructions;
      let rebuilds=0;
      renderer.renderGroup._buildInstructions=function(...args){rebuilds++;return builds.apply(this,args)};
      let actual;
      try {filters.forEach((f,i)=>updateFilter(f,b[i]));if(cached){wrapper.refresh();wrapper.revision++;}actual=pixels();}
      finally {renderer.renderGroup._buildInstructions=builds;}
      shape.filters=null;if(cached)wrapper.destroy();filters.forEach(destroyFilter);
      const fresh=b.map(createFilter);
      if(name==='text outline')for(const f of fresh)f.antialias='on';
      const referenceWrapper=cached?new RetainedEffects(fresh,stats):null;
      shape.filters=cached?[referenceWrapper]:fresh;const expected=pixels();
      let max=0,sum=0;for(let i=0;i<actual.length;i++){const d=Math.abs(actual[i]-expected[i]);max=Math.max(max,d);sum+=d;}
      results.push({name,cached,rebuilds,max,mean:sum/actual.length});
      shape.filters=null;if(cached)referenceWrapper.destroy();fresh.forEach(destroyFilter);
      if(max>1||rebuilds)throw Error("Filter update regression: "+JSON.stringify(results.at(-1)));
    }
    for(const [a,b] of [
      [{filterName:"glow",blurX:8,blurY:8},{filterName:"glow",blurX:12,blurY:12}],
      [{filterName:"glow",blurX:3,blurY:3,strength:2},{filterName:"glow",blurX:3,blurY:3,strength:10}],
    ]) if(JSON.stringify(filterProgramKey(describeFilter(a)))===JSON.stringify(filterProgramKey(describeFilter(b))))throw Error("Shader change must replace filter");
    return {results,retainedPixels:stats.effectCachePixels,glError:renderer.gl.getError()};
  } finally {scene.destroy({children:true});renderer.destroy();}
}
