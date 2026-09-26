import assert from 'node:assert/strict';
import { snapshotSolidPath, snapshotStrokePath, snapshotGradientPath, snapshotBitmapFill, installPathSource } from '../../src/graphics/path-source.mjs';
const path = { commands:[1,2,3,6],data:[0,0,10,0,15,5,10,10,5,15,0,10,0,0],
  style:{data_type:'[graphicsdata FillStyle]',fillStyle:{data_type:'[graphicsdata SolidFillStyle]',color:0x2266cc,alpha:.7}} };
const snapshot=snapshotSolidPath(path);
assert.equal(snapshot.color,0x2266cc);
assert.notEqual(snapshot.data,path.data);
assert.ok(Object.isFrozen(snapshot.data));
assert.ok(Object.isFrozen(snapshot.segments));
assert.deepEqual(snapshot.segments.map(({command,args})=>[command,args]),
  [[1,[0,0]],[2,[10,0]],[3,[15,5,10,10]],[6,[5,15,0,10,0,0]]]);
assert.equal(snapshot.bounds.x,0);assert.equal(snapshot.bounds.y,0);
assert.ok(snapshot.bounds.width>10 && snapshot.bounds.height>10);
const quadratic=snapshotSolidPath({...path,commands:[1,2,3],data:[0,0,0,0,10,20,20,0]});
assert.deepEqual(quadratic.bounds,{x:0,y:0,width:20,height:10},
  'quadratic bounds include the curve extremum rather than only endpoints');
const cubic=snapshotSolidPath({...path,commands:[1,2,6],data:[0,0,0,0,0,30,30,30,30,0]});
assert.deepEqual(cubic.bounds,{x:0,y:0,width:30,height:22.5},
  'cubic bounds include the curve extremum rather than only endpoints');
for(const p of [{...path,morphSource:true},{...path,commands:[1,1]},
  {...path,verts:[0,0,10,0,10,10]}, {...path,commands:[1],data:[0,0]},
  {...path,commands:[99]}, {...path,data:[NaN]},
  {...path,style:{data_type:'stroke'}}, {...path,style:{fillStyle:{data_type:'bitmap'}}}])
  assert.equal(snapshotSolidPath(p),null);
const asset=()=>({abstractions:new Map(),addAbstraction(a){this.abstractions.set(a.id,a);},
  removeAbstraction(a){this.abstractions.delete(a.id);},invalidate(){for(const a of [...this.abstractions.values()])a.onInvalidate();}});
const elements=asset();elements.positions={attributesBuffer:asset()};
const shape={elements,material:{},style:{}};
class Graphics {addShapeInternal(s){this.shape=s;}}
const Factory={pathToAttributesBuffer(){return {};},draw_pathes(g,p){this.pathToAttributesBuffer(p);g.addShapeInternal(shape);}};
const source=installPathSource(Graphics,Factory),g=new Graphics();
Factory.draw_pathes(g,path);
assert.deepEqual(source.get(shape),{...snapshot,rasterStable:false});
assert.ok(source.get({...shape}),'shared elements retain authored commands');
assert.equal(source.get({...shape,offset:3}),null);
assert.equal(source.get({...shape,style:{}}),null);
elements.positions.attributesBuffer.invalidate();assert.equal(source.get(shape),null);
Factory.draw_pathes(g,path);elements.invalidate();assert.equal(source.get(shape),null);
Factory.draw_pathes(g,path);g.addShapeInternal(shape);assert.equal(source.get(shape),null,'pooled non-path shape');
Factory.draw_pathes(g,path);Factory.draw_pathes(g,{...path,morphSource:true});assert.equal(source.get(shape),null);
console.log('Passed authored command snapshots, unsupported paths, shared instances, buffer edits and pooled shape invalidation.');

const stroke = {commands:[1,2,1,3],data:[0,0,10,0,20,0,25,5,30,0],
  style:{data_type:'[graphicsdata StrokeStyle]',fillStyle:path.style.fillStyle,
    thickness:4,scaleMode:2,capstyle:1,jointstyle:2,miterLimit:5}};
assert.deepEqual(snapshotStrokePath(stroke).stroke,{width:4,cap:'round',join:'miter',miterLimit:5});
assert.ok(Object.isFrozen(snapshotStrokePath(stroke).stroke));
assert.equal(snapshotStrokePath({...stroke,style:{...stroke.style,capstyle:'square',jointstyle:'bevel'}}).stroke.cap,'square');
assert.equal(snapshotStrokePath({...stroke,style:{...stroke.style,capstyle:null,jointstyle:null}}).stroke.join,'round');
assert.equal(snapshotStrokePath({...stroke,commands:[1,2],data:[0,0,20,0]}).commands.length,2);
assert.deepEqual(snapshotStrokePath({...stroke,style:{...stroke.style,scaleMode:4,thickness:0.05}}).stroke,
  {width:1,pixelLine:true,cap:'round',join:'miter',miterLimit:5},'hairlines become one-pixel lines');
for (const style of [{scaleMode:1},{scaleMode:3},{thickness:0},{thickness:Infinity},
  {capstyle:9},{jointstyle:9},{miterLimit:NaN}])
  assert.equal(snapshotStrokePath({...stroke,style:{...stroke.style,...style}}),null);
const strokeElements=asset();strokeElements.positions={attributesBuffer:asset()};
strokeElements.thickness={attributesBuffer:asset()};
const strokeShape={elements:strokeElements,style:{},material:{}};
class StrokeGraphics {addShapeInternal(s){this.shape=s;}}
const fillFactory={pathToAttributesBuffer(){},draw_pathes(){}};
const strokes={fillLineElements(){return strokeElements;},draw_pathes(g,p){this.fillLineElements([p]);g.addShapeInternal(strokeShape);}};
const strokeSource=installPathSource(StrokeGraphics,fillFactory,strokes),sg=new StrokeGraphics();
strokes.draw_pathes(sg,stroke);assert.deepEqual(strokeSource.get(strokeShape),{...snapshotStrokePath(stroke),rasterStable:false});
strokeElements.thickness.attributesBuffer.invalidate();assert.equal(strokeSource.get(strokeShape),null);
strokes.draw_pathes(sg,stroke);sg.addShapeInternal(strokeShape);assert.equal(strokeSource.get(strokeShape),null);
console.log('Passed normal stroke snapshots, cap/join mapping, multiple contours and thickness invalidation.');

const gradientPath={...path,style:{data_type:'[graphicsdata FillStyle]',fillStyle:{
  data_type:'[graphicsdata GradientFillStyle]',type:'linear',spreadMethod:'pad',interpolationMethod:'rgb',
  colors_r:[255,0],colors_g:[0,0],colors_b:[0,255],alphas:[1,.5],ratios:[0,255]}}};
const gradient=snapshotGradientPath(gradientPath);
assert.equal(gradient.gradient.type,'linear');
assert.deepEqual(gradient.gradient.stops,[{offset:0,color:0xff0000,alpha:1},{offset:1,color:0xff,alpha:.5}]);
assert.ok(Object.isFrozen(gradient.gradient.stops));
for(const change of [{type:'focal'},{spreadMethod:'reflect'},{interpolationMethod:'linearRGB'},
  {alphas:[1,NaN]},{ratios:[0,256]}])
  assert.equal(snapshotGradientPath({...gradientPath,style:{...gradientPath.style,
    fillStyle:{...gradientPath.style.fillStyle,...change}}}),null);
const gradientElements=asset();gradientElements.positions={attributesBuffer:asset()};
const gradientShape={elements:gradientElements,material:{},
  style:{uvMatrix:{a:.1,b:0,c:0,d:0,tx:0,ty:.5}}};
class GradientGraphics {addShapeInternal(s){this.shape=s;}}
const gradientFactory={pathToAttributesBuffer(){return {};},draw_pathes(g,p){this.pathToAttributesBuffer(p);g.addShapeInternal(gradientShape);}};
const gradientSource=installPathSource(GradientGraphics,gradientFactory),gg=new GradientGraphics();
gradientFactory.draw_pathes(gg,gradientPath);
assert.deepEqual(gradientSource.get(gradientShape).gradient.uv,[.1,0,0,0,0,.5]);
gradientElements.positions.attributesBuffer.invalidate();assert.equal(gradientSource.get(gradientShape),null);
gradientShape.style={uvMatrix:{a:0,b:0,c:0,d:0,tx:0,ty:0}};
gradientFactory.draw_pathes(gg,gradientPath);assert.equal(gradientSource.get(gradientShape),null);
console.log('Passed linear gradient stops, UV snapshots, unsupported modes and invalidation.');
const radialPath={...gradientPath,style:{...gradientPath.style,fillStyle:{...gradientPath.style.fillStyle,
  type:'radial',focalPointRatio:0}}};
assert.equal(snapshotGradientPath(radialPath).gradient.type,'radial');
assert.equal(snapshotGradientPath({...radialPath,style:{...radialPath.style,
  fillStyle:{...radialPath.style.fillStyle,focalPointRatio:0.5}}}),null);
assert.equal(snapshotGradientPath({...radialPath,style:{...radialPath.style,
  fillStyle:{...radialPath.style.fillStyle,focalPointRatio:1.5}}}),null);

const image={width:16,height:8},bitmapPath={...path,style:{data_type:'[graphicsdata FillStyle]',
  fillStyle:{data_type:'[graphicsdata BitmapFillStyle]',image,repeat:true,smooth:false}}};
const bitmap=snapshotBitmapFill(bitmapPath);
assert.equal(bitmap.bitmap.image,image);
assert.deepEqual([bitmap.bitmap.width,bitmap.bitmap.height,bitmap.bitmap.smooth],[16,8,false]);
assert.equal(snapshotBitmapFill({...bitmapPath,style:{...bitmapPath.style,
  fillStyle:{...bitmapPath.style.fillStyle,repeat:false}}}),null);
assert.equal(snapshotBitmapFill({...bitmapPath,style:{...bitmapPath.style,
  fillStyle:{...bitmapPath.style.fillStyle,image:null}}}),null);
const bitmapElements=asset();bitmapElements.positions={attributesBuffer:asset()};
const bitmapShape={elements:bitmapElements,material:{},
  style:{uvMatrix:{a:1/16,b:0,c:0,d:1/8,tx:0,ty:0}}};
class BitmapGraphics {addShapeInternal(s){this.shape=s;}}
const bitmapFactory={pathToAttributesBuffer(){return {};},draw_pathes(g,p){this.pathToAttributesBuffer(p);g.addShapeInternal(bitmapShape);}};
const bitmapSource=installPathSource(BitmapGraphics,bitmapFactory),bg=new BitmapGraphics();
bitmapFactory.draw_pathes(bg,bitmapPath);
assert.deepEqual(bitmapSource.get(bitmapShape).bitmap.uv,[1/16,0,0,1/8,0,0]);
bitmapElements.positions.attributesBuffer.invalidate();assert.equal(bitmapSource.get(bitmapShape),null);
bitmapShape.style={uvMatrix:{a:0,b:0,c:0,d:0,tx:0,ty:0}};
bitmapFactory.draw_pathes(bg,bitmapPath);assert.equal(bitmapSource.get(bitmapShape),null);
console.log('Passed bitmap fill snapshots, repeat fallback, UV mapping and invalidation.');

const compound={...path,commands:[1,2,2,2,2,1,2,2,2,2],
  data:[0,0,100,0,100,100,0,100,0,0,30,30,70,30,70,70,30,70,30,30]};
assert.equal(snapshotSolidPath(compound).commands.filter(c=>c===1).length,2);
assert.ok(snapshotGradientPath({...compound,style:gradientPath.style}));
assert.ok(snapshotBitmapFill({...compound,style:bitmapPath.style}));
const threeContours={...compound,commands:[...compound.commands,1,2,2,2,2],
  data:[...compound.data,110,0,130,0,130,20,110,20,110,0]};
assert.equal(snapshotSolidPath(threeContours).contours,3);
assert.equal(snapshotGradientPath({...threeContours,style:gradientPath.style}).contours,3);
assert.equal(snapshotBitmapFill({...threeContours,style:bitmapPath.style}).contours,3);
console.log('Passed multi-contour fill snapshots.');

// SWF definition paths are captured as records become GraphicsPath objects,
// before the rendering factory receives them. Later script edits must use the
// current path rather than the old definition snapshot.
const definedElements=asset();definedElements.positions={attributesBuffer:asset()};
const definedShape={elements:definedElements,material:{},style:{}};
const authored={...path,commands:[...path.commands],data:[...path.data],_dirtyID:1};
class DefinitionGraphics {
  convertRecordsToShapeData() { this.add_queued_path(authored); }
  add_queued_path(p) { this.queued=p; }
  addShapeInternal(s) { this.shape=s; }
}
const definitionFactory={pathToAttributesBuffer(){},draw_pathes(g,p){this.pathToAttributesBuffer(p);g.addShapeInternal(definedShape);}};
const definitionSource=installPathSource(DefinitionGraphics,definitionFactory);
const dg=new DefinitionGraphics();
dg.convertRecordsToShapeData();
authored.commands=[...authored.commands];authored.data=[...authored.data];
definitionFactory.draw_pathes(dg,authored);
assert.deepEqual(definitionSource.get(definedShape),{...snapshotSolidPath(authored),rasterStable:true});
authored.lineTo=()=>{};authored.commands.push(2);authored.data.push(3,4);authored._dirtyID++;
definitionFactory.draw_pathes(dg,authored);
assert.deepEqual(definitionSource.get(definedShape),{...snapshotSolidPath(authored),rasterStable:false},
  'later edits cannot reuse the original definition');
console.log('Passed SWF definition capture and edited-path fallback.');

// drawRect/drawCircle/drawEllipse create vertices directly, with no drawable
// command path. A single untouched primitive can still be recovered.
const primitiveElements=asset();primitiveElements.positions={attributesBuffer:asset()};
const primitiveShape={elements:primitiveElements,material:{},style:{}};
class PrimitiveGraphics {
  constructor() { this._active_fill_path={commands:[],data:[],verts:[],_dirtyID:0,style:path.style}; }
  addShapeInternal() {}
  drawRect(x,y) { this._active_fill_path.commands.push(1);
    this._active_fill_path.data.push(x,y);this._active_fill_path.verts.push(1,2,3);
    this._active_fill_path._dirtyID++; }
  drawCircle(x,y) { this.drawRect(x,y); }
  drawEllipse(x,y) { this.drawRect(x,y); }
  drawRoundRect(x,y) { this.drawRect(x,y); }
}
const primitiveFactory={pathToAttributesBuffer(){},draw_pathes(g,p){this.pathToAttributesBuffer(p);g.addShapeInternal(primitiveShape);}};
const primitiveSource=installPathSource(PrimitiveGraphics,primitiveFactory);
const pg=new PrimitiveGraphics();
pg.drawRect(0,0,30,20);primitiveFactory.draw_pathes(pg,pg._active_fill_path);
assert.deepEqual(primitiveSource.get(primitiveShape).primitive,{kind:'rect',args:[0,0,30,20]});
assert.deepEqual(primitiveSource.get(primitiveShape).bounds,{x:0,y:0,width:30,height:20});
primitiveElements.positions.attributesBuffer.invalidate();
assert.equal(primitiveSource.get(primitiveShape),null);
pg.drawRect(30,0,30,20);primitiveFactory.draw_pathes(pg,pg._active_fill_path);
assert.equal(primitiveSource.get(primitiveShape),null,'multiple draw calls remain a mesh');
for(const [method,args,kind] of [['drawCircle',[15,15,12],'circle'],
  ['drawEllipse',[0,0,30,20],'ellipse'],
  ['drawRoundRect',[0,0,30,20,8],'roundRect']]) {
  const next=new PrimitiveGraphics();next[method](...args);
  primitiveFactory.draw_pathes(next,next._active_fill_path);
  const expected=kind==='roundRect'?[0,0,30,20,4]:args;
  assert.deepEqual(primitiveSource.get(primitiveShape).primitive,{kind,args:expected});
}
const ellipseCorners=new PrimitiveGraphics();ellipseCorners.drawRoundRect(0,0,30,20,8,4);
primitiveFactory.draw_pathes(ellipseCorners,ellipseCorners._active_fill_path);
assert.equal(primitiveSource.get(primitiveShape),null,'elliptical corners remain meshes');
const edited=new PrimitiveGraphics();edited.drawRect(0,0,30,20);
edited._active_fill_path.commands.push(2);edited._active_fill_path.data.push(30,20);
primitiveFactory.draw_pathes(edited,edited._active_fill_path);
assert.equal(primitiveSource.get(primitiveShape),null,'edited primitives remain meshes');
console.log('Passed isolated primitive capture, mixed-call fallback and edit invalidation.');

// Authored solid fills can defer AwayFL triangles while Pixi is active. Native
// picking before Pixi's first draw, offscreen draws, and renderer switching
// must materialize the actual geometry on demand.
class Buffer {
  constructor(stride, count) { this.stride=stride;this.count=count;
    this.buffer=new ArrayBuffer(stride*count);this.abstractions=new Map(); }
  addAbstraction(a) {this.abstractions.set(a.id,a);}
  removeAbstraction(a) {this.abstractions.delete(a.id);}
  invalidate() {for(const a of [...this.abstractions.values()])a.onInvalidate();}
}
function lazyElements(buffer) {
  return {concatenatedBuffer:buffer,positions:{attributesBuffer:buffer},
    _numVertices:buffer.count,abstractions:new Map(),
    addAbstraction(a){this.abstractions.set(a.id,a);},
    removeAbstraction(a){this.abstractions.delete(a.id);},
    invalidate(){for(const a of [...this.abstractions.values()])a.onInvalidate();},
    clear(){for(const a of [...this.abstractions.values()])a.onClear();},
    hitTestPoint(){return true;},getBoxBounds(){return null;}};
}
class LazyGraphics {
  constructor(sourcePath=path,style={}){this._clearCount=0;this.path={...sourcePath,
    commands:[...sourcePath.commands],data:[...sourcePath.data],_dirtyID:1};
    this.shapeStyle=style;}
  convertRecordsToShapeData(){this.add_queued_path(this.path);}
  add_queued_path(){}
  addShapeInternal(shape){this.shape=shape;}
}
class DisplayObject {}
class SceneImage2D {draw(){return 'drawn';}}
let conversions=0;
const lazyFactory={pathToAttributesBuffer(p,close,target){
  conversions++;
  const b=target||new Buffer(8,9);
  b.count=9;b.buffer=new ArrayBuffer(8*9);return b;
},draw_pathes(g,p){
  const b=this.pathToAttributesBuffer(p,false);
  const elements=lazyElements(b);
  g.addShapeInternal({elements,material:{},style:g.shapeStyle});
}};
const lazySource=installPathSource(LazyGraphics,lazyFactory,null,null,
  {AttributesBuffer:Buffer,DisplayObject,SceneImage2D});
function authoredLazyShape(sourcePath,style){const g=new LazyGraphics(sourcePath,style);
  g.convertRecordsToShapeData();
  lazyFactory.draw_pathes(g,g.path);return g.shape;}
lazySource.setLiteGeometry(true);
const firstLazy=authoredLazyShape();
assert.equal(conversions,0,'authored solid fill skipped AwayFL tessellation');
assert.equal(firstLazy.elements.concatenatedBuffer.count,6);
assert.ok(lazySource.get(firstLazy));
firstLazy.elements.hitTestPoint();
assert.equal(conversions,1,'early native picking materializes geometry');
assert.equal(firstLazy.elements.concatenatedBuffer.count,9);
const secondLazy=authoredLazyShape();
assert.equal(conversions,1);
assert.equal(new SceneImage2D().draw(new DisplayObject()),'drawn');
assert.equal(conversions,2,'BitmapData.draw materializes deferred display geometry');
const thirdLazy=authoredLazyShape();
assert.equal(conversions,2);
lazySource.setLiteGeometry(false);
assert.equal(conversions,3,'switching back materializes remaining geometry');
assert.equal(Object.hasOwn(thirdLazy.elements,'hitTestPoint'),true,
  'the original instance hit test is restored');
assert.equal(lazySource.lazyStats.live,0);
lazySource.setLiteGeometry(true);
const uvMatrix={a:1,b:0,c:0,d:1,tx:0,ty:0};
const gradientLazy=authoredLazyShape(gradientPath,{uvMatrix});
assert.equal(conversions,3,'authored gradient fill skips tessellation');
assert.ok(lazySource.get(gradientLazy)?.gradient);
const bitmapLazy=authoredLazyShape(bitmapPath,{uvMatrix});
assert.equal(conversions,3,'authored repeating bitmap fill skips tessellation');
assert.ok(lazySource.get(bitmapLazy)?.bitmap);
const compoundLazy=authoredLazyShape(compound);
assert.equal(conversions,3,'authored compound fill skips tessellation');
assert.equal(lazySource.get(compoundLazy)?.contours,2);
compoundLazy.elements.hitTestPoint();
assert.equal(conversions,4,'native hit test materializes compound fill geometry');
lazySource.ensureGeometry(bitmapLazy);
assert.equal(conversions,5,'Pixi mesh fallback builds real bitmap geometry');
const invalidGradient=authoredLazyShape(gradientPath,{uvMatrix:{...uvMatrix,a:0,d:0}});
assert.equal(conversions,6,'invalid paint mapping builds real geometry immediately');
assert.equal(lazySource.get(invalidGradient),null);
lazySource.setLiteGeometry(false);
assert.equal(conversions,7,'remaining gradient materializes on renderer switch');
console.log('Passed deferred authored fills, native picking, offscreen draw, mesh fallback and switch-back materialization.');

// A generated morph path has no decoder snapshot. Its start/end definitions
// identify it as a morph, so Pixi can consume its commands before AwayFL
// tessellates the same path into triangles.
lazySource.setLiteGeometry(true);
lazySource.setMorphLiteGeometry(true);
const morphFill=new LazyGraphics();
morphFill._clearCount=1;morphFill.start=[path];morphFill.end=[path];
const beforeMorph=conversions;
lazyFactory.draw_pathes(morphFill,morphFill.path);
assert.equal(conversions,beforeMorph,'morph fill skips AwayFL tessellation');
assert.ok(lazySource.get(morphFill.shape));
assert.equal(lazySource.lazyStats.morphSkipped,1);
const retiredMorph=new LazyGraphics();
retiredMorph._clearCount=1;retiredMorph.start=[path];retiredMorph.end=[path];
lazyFactory.draw_pathes(retiredMorph,retiredMorph.path);
retiredMorph.shape.elements.clear();
assert.equal(lazySource.lazyStats.live,1,'retired morph releases deferred geometry');
lazySource.setLiteGeometry(false);
assert.equal(conversions,beforeMorph+1,'morph fallback materializes exact triangles');
assert.equal(lazySource.lazyStats.morphMaterialized,1);

class StrokeLineElements {
  constructor(buffer){this.positions={attributesBuffer:buffer};this.thickness={attributesBuffer:buffer};
    this.abstractions=new Map();}
  setPositions(values){this.vertices=values;this.positions.attributesBuffer.count=4;}
  setThickness(values){this.widths=values;}
  addAbstraction(a){this.abstractions.set(a.id,a);}
  removeAbstraction(a){this.abstractions.delete(a.id);}
  invalidate(){for(const a of [...this.abstractions.values()])a.onInvalidate();}
  hitTestPoint(){return true;}
}
class LazyStrokeGraphics {
  constructor(){this._clearCount=0;this.path={...stroke,commands:[...stroke.commands],
    data:[...stroke.data],_dirtyID:1};}
  convertRecordsToShapeData(){this.add_queued_path(this.path);}
  add_queued_path(){}
  addShapeInternal(shape){this.shape=shape;}
}
let lineBuilds=0;
const strokeFactory={pathToAttributesBuffer(){},draw_pathes(){}};
const lazyStrokes={fillLineElements(paths,curves,mode,target){
  lineBuilds++;
  const elements=target||new StrokeLineElements(new Buffer(8,4));
  elements.setPositions([0,0,0,10,10,0,10,10,0,20,0,0]);
  elements.setThickness([2,2]);
  return elements;
},draw_pathes(g){const elements=this.fillLineElements([g.path],false,2);
  g.addShapeInternal({elements,material:{},style:{}});}};
const strokeLazySource=installPathSource(LazyStrokeGraphics,strokeFactory,lazyStrokes,null,
  {AttributesBuffer:Buffer,LineElements:StrokeLineElements,DisplayObject,SceneImage2D});
function authoredLazyStroke(){const g=new LazyStrokeGraphics();g.convertRecordsToShapeData();
  lazyStrokes.draw_pathes(g);return g.shape;}
strokeLazySource.setLiteGeometry(true);
const firstStroke=authoredLazyStroke();
assert.equal(lineBuilds,0,'authored normal stroke skips AwayFL line generation');
assert.ok(strokeLazySource.get(firstStroke)?.stroke);
assert.equal(firstStroke.elements.vertices.length,6,'stroke placeholder has one conservative segment');
firstStroke.elements.hitTestPoint();
assert.equal(lineBuilds,1,'early native stroke hit materializes line geometry');
const secondStroke=authoredLazyStroke();
assert.equal(lineBuilds,1);
strokeLazySource.ensureGeometry(secondStroke);
assert.equal(lineBuilds,2,'Pixi mesh fallback materializes line geometry');
const thirdStroke=authoredLazyStroke();
strokeLazySource.setLiteGeometry(false);
assert.equal(lineBuilds,3,'switching back materializes the remaining stroke');
assert.equal(strokeLazySource.lazyStats.live,0);
assert.deepEqual([strokeLazySource.lazyStats.skippedStrokes,
  strokeLazySource.lazyStats.materializedStrokes,strokeLazySource.lazyStats.liveStrokes],
  [3,3,0]);
console.log('Passed deferred authored normal strokes, native hit, mesh fallback and switch-back materialization.');
strokeLazySource.setLiteGeometry(true);
strokeLazySource.setMorphLiteGeometry(true);
const morphStroke=new LazyStrokeGraphics();
morphStroke._clearCount=1;morphStroke.start=[stroke];morphStroke.end=[stroke];
const beforeMorphLines=lineBuilds;
lazyStrokes.draw_pathes(morphStroke);
assert.equal(lineBuilds,beforeMorphLines,'morph stroke skips AwayFL line generation');
assert.ok(strokeLazySource.get(morphStroke.shape)?.stroke);
strokeLazySource.setLiteGeometry(false);
assert.equal(lineBuilds,beforeMorphLines+1,'morph stroke fallback builds exact geometry');
assert.equal(strokeLazySource.lazyStats.morphMaterialized,1);
