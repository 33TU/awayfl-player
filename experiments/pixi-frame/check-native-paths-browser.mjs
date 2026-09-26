export async function checkNativePaths(player, live) {
  const g=player.root._children.find(n=>n.name==='scene').adapter,s=g.sec;
  const hidden=g.adaptee._children.map(n=>[n,n.visible]);
  for(const [n] of hidden)n.visible=false;
  const sprite=()=>s.flash.display.Sprite.axClass.axConstruct([]);
  const a=sprite(),b=sprite();g.$BgaddChild(a);g.$BgaddChild(b);
  a.$Bgx=100;a.$Bgy=100;b.$Bgx=160;b.$Bgy=100;
  const draw=(n,color,w)=>{const g=n.$Bggraphics;g.$Bgclear();g.$BgbeginFill(color);g.$BgmoveTo(0,0);g.$BglineTo(w,0);g.$BglineTo(w,30);g.$BglineTo(0,30);g.$BglineTo(0,0);g.$BgendFill();};
  const graphics=n=>live.getDisplayObject(n).children[0].children.find(c=>c.context);
  const frame=()=>{player._renderer.render();if(live.stats.lastError)throw Error(live.stats.lastError);};
  function pixel(n,x,y,expected) {
    const canvas=player._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');
    const gl=canvas.getContext('webgl2'),bytes=new Uint8Array(4);
    const point=live.getDisplayObject(n).toGlobal({x,y});
    gl.readPixels(Math.floor(point.x),canvas.height-1-Math.floor(point.y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
    if(expected.some((v,i)=>Math.abs(v-bytes[i])>1))throw Error(`Native fill pixel: ${Array.from(bytes)} expected ${expected}; point=${JSON.stringify(point)} bounds=${JSON.stringify(graphics(n).getBounds())} tint=${graphics(n).tint}`);
  }
  try {
    draw(a,0x2266cc,30);frame();
    if(!graphics(a))throw Error('Authored rectangle did not use Pixi Graphics');
    const pickedElements=a.adaptee.graphics.getShapeAt(0).elements;
    if(!Object.hasOwn(pickedElements,'hitTestPoint') ||
       !pickedElements.hitTestPoint(null,15,15) ||
       pickedElements.hitTestPoint(null,40,15))
      throw Error('Flash picking did not use the retained Pixi path');
    const bounds=pickedElements.getBoxBounds();
    if(!Object.hasOwn(pickedElements,'getBoxBounds') ||
       bounds.x>0 || bounds.y>0 || bounds.x+bounds.width<30 ||
       bounds.y+bounds.height<30)
      throw Error('Flash bounds did not include the retained Pixi rectangle');
    pixel(a,15,15,[34,102,204,255]);
    a.adaptee.graphics.copyTo(b.adaptee.graphics);frame();
    const context=graphics(a).context;
    if(graphics(b).context!==context)throw Error('Instances did not share GraphicsContext');
    const before=live.stats.nativePathBuilds;
    a.$Bgx+=10;a.$Bgalpha=0.5;frame();
    if(graphics(a).context!==context||live.stats.nativePathBuilds!==before)throw Error('Transform rebuilt path');
    draw(a,0xff8800,45);frame();
    if(graphics(a).context===context||graphics(b).context!==context)throw Error('Geometry edit corrupted shared context');
    pixel(b,15,15,[34,102,204,255]);
    a.$Bggraphics.$Bgclear();frame();
    if(graphics(a))throw Error('Cleared path survived');
    if(!Object.hasOwn(pickedElements,'hitTestPoint'))
      throw Error('Clearing one shared instance removed the other instance\'s Pixi picking hook');
    b.$Bgvisible=false;frame();b.$Bgvisible=true;frame();
    if(graphics(b).context!==context)throw Error('Hidden path was prematurely destroyed');
    a.$Bgalpha=1;
    const cg=a.$Bggraphics;cg.$BgbeginFill(0x2266cc);cg.$BgmoveTo(0,0);
    cg.$BglineTo(30,0);cg.$BgcurveTo(50,15,30,30);cg.$BgcubicCurveTo(20,40,0,40,0,0);cg.$BgendFill();frame();
    if(!graphics(a))throw Error('Curves did not use Pixi Graphics');
    pixel(a,15,10,[34,102,204,255]);
    cg.$Bgclear();cg.$BgbeginFill(0x2266cc);cg.$BgdrawRect(0,0,30,30);
    cg.$BgendFill();frame();
    if(!graphics(a))throw Error('Rectangle did not use native Pixi Graphics');
    pixel(a,15,15,[34,102,204,255]);
    cg.$Bgclear();cg.$BgbeginFill(0x2266cc);cg.$BgdrawCircle(15,15,15);cg.$BgendFill();frame();
    if(!graphics(a))throw Error('Circle did not use native Pixi Graphics');
    pixel(a,15,15,[34,102,204,255]);
    cg.$Bgclear();cg.$BgbeginFill(0x2266cc);cg.$BgdrawEllipse(0,0,30,30);cg.$BgendFill();frame();
    if(!graphics(a))throw Error('Ellipse did not use native Pixi Graphics');
    pixel(a,15,15,[34,102,204,255]);
    cg.$Bgclear();cg.$BgbeginFill(0x2266cc);cg.$BgdrawRoundRect(0,0,30,30,12);cg.$BgendFill();frame();
    if(!graphics(a))throw Error('Rounded rectangle did not use native Pixi Graphics');
    pixel(a,15,15,[34,102,204,255]);
    cg.$Bgclear();cg.$BgbeginFill(0x2266cc);cg.$BgdrawRoundRect(0,0,30,30,12,6);
    cg.$BgendFill();frame();
    if(graphics(a))throw Error('Elliptical corners were mistaken for circular Pixi corners');
    pixel(a,15,15,[34,102,204,255]);
    cg.$Bgclear();cg.$BgbeginFill(0x2266cc);cg.$BgdrawRect(0,0,15,30);
    cg.$BgdrawRect(15,0,15,30);cg.$BgendFill();frame();
    if(graphics(a))throw Error('Multiple primitives were mistaken for one Pixi primitive');
    pixel(a,15,15,[34,102,204,255]);
    cg.$Bgclear();
    cg.$BglineStyle(8,0xff8800,1,false,'normal','square','miter',5);
    cg.$BgmoveTo(0,10);cg.$BglineTo(40,10);frame();
    const stroke=graphics(a);
    if(!stroke)throw Error('Normal stroke did not use Pixi Graphics');
    const strokeElements=a.adaptee.graphics.getShapeAt(0).elements;
    if(!Object.hasOwn(strokeElements,'hitTestPoint') ||
       !strokeElements.hitTestPoint(null,20,10) ||
       strokeElements.hitTestPoint(null,20,25))
      throw Error('Normal stroke picking did not use the retained Pixi path');
    const strokeBounds=strokeElements.getBoxBounds();
    if(!Object.hasOwn(strokeElements,'getBoxBounds') ||
       strokeBounds.x>0 || strokeBounds.x+strokeBounds.width<40 ||
       strokeBounds.y>6 || strokeBounds.y+strokeBounds.height<14)
      throw Error('Flash bounds did not include Pixi stroke thickness');
    pixel(a,20,10,[255,136,0,255]);pixel(a,-2,10,[255,136,0,255]);
    const strokeContext=stroke.context,strokeBuilds=live.stats.nativePathBuilds;
    a.$BgscaleX=1.5;a.$Bgrotation=15;frame();
    if(graphics(a).context!==strokeContext||live.stats.nativePathBuilds!==strokeBuilds)
      throw Error('Stroke transform rebuilt shared context');
    pixel(a,20,10,[255,136,0,255]);
    a.$BgscaleX=1;a.$Bgrotation=0;
    cg.$Bgclear();cg.$BglineStyle(4,0xff8800,1,false,'normal','round','round',5);
    cg.$BgmoveTo(0,0);cg.$BglineTo(30,0);cg.$BglineTo(30,30);cg.$BglineTo(0,0);
    cg.$BgmoveTo(0,50);cg.$BgcurveTo(20,40,40,50);frame();
    if(!graphics(a))throw Error('Multi-contour curved stroke did not use Pixi Graphics');
    pixel(a,15,0,[255,136,0,255]);
    cg.$Bgclear();cg.$BglineStyle(1,0xffffff,1,false,'none');
    // The legacy script bridge drops scaleMode; set the decoded style here to
    // exercise the SWF non-scaling case without changing that runtime API.
    a.adaptee.graphics._lineStyle.scaleMode=1;
    cg.$BgmoveTo(0,0);cg.$BglineTo(30,0);frame();
    if(graphics(a))throw Error('Non-scaling stroke must retain its screen-space implementation');
    // A zero-width Flash stroke is a hairline: one device pixel at any scale,
    // which maps to Pixi's pixelLine stroke through the authored path.
    cg.$Bgclear();cg.$BglineStyle(0,0xff8800,1);
    cg.$BgmoveTo(0,10);cg.$BglineTo(30,10);cg.$BglineTo(30,40);frame();
    if(!graphics(a))throw Error('Hairline stroke did not use Pixi Graphics');
    const hairlineContext=graphics(a).context,hairlineBuilds=live.stats.nativePathBuilds;
    a.$BgscaleX=3;frame();
    if(graphics(a).context!==hairlineContext||live.stats.nativePathBuilds!==hairlineBuilds)
      throw Error('Hairline transform rebuilt shared context');
    a.$BgscaleX=1;
    // A closed hairline outline must stay an outline: interior untouched,
    // edge carrying the stroke color.
    cg.$Bgclear();cg.$BglineStyle(0,0xff8800,1);
    cg.$BgmoveTo(0,0);cg.$BglineTo(40,0);cg.$BglineTo(40,40);cg.$BglineTo(0,40);cg.$BglineTo(0,0);frame();
    if(!graphics(a))throw Error('Closed hairline did not use Pixi Graphics');
    const read=(x,y)=>{const canvas=player._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');
      const gl=canvas.getContext('webgl2'),bytes=new Uint8Array(4);const point=live.getDisplayObject(a).toGlobal({x,y});
      gl.readPixels(Math.floor(point.x),canvas.height-1-Math.floor(point.y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,bytes);return Array.from(bytes);};
    const interior=read(20,20);
    if(interior[0]>8||interior[1]>8)throw Error('Closed hairline filled its interior: '+interior);
    const edge=[read(20,-1),read(20,0),read(20,1)];
    if(!edge.some(p=>p[0]>100&&p[2]<60))throw Error('Closed hairline edge missing: '+JSON.stringify(edge));
    a.adaptee.graphics.clear();
    return {shared:true,transformReused:true,editIsolated:true,clear:true,picking:true,visibility:true,hairline:true,
      curves:true,nativePrimitives:true,roundRect:true,ellipticalCornerFallback:true,
      mixedPrimitiveFallback:true,pixels:true,normalStroke:true,strokeTransformReused:true,
      multipleStrokeContours:true,nonScalingFallback:true,
      nativePathBuilds:live.stats.nativePathBuilds,nativePathShares:live.stats.nativePathShares};
  } finally {g.$BgremoveChild(a);g.$BgremoveChild(b);for(const [n,v]of hidden)n.visible=v;frame();}
}
