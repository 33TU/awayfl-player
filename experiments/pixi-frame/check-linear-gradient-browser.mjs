// Offline fixture: compare authored Pixi gradients with the existing mesh path.
export async function checkLinearGradient(player) {
  const g = player.root._children.find(n => n.name === 'scene').adapter, s = g.sec;
  const hidden = g.adaptee._children.map(n => [n, n.visible]);
  for (const [n] of hidden) n.visible = false;
  const a = s.flash.display.Sprite.axClass.axConstruct([]);
  const b = s.flash.display.Sprite.axClass.axConstruct([]);
  g.$BgaddChild(a); a.$Bgx = 180; a.$Bgy = 120;
  g.$BgaddChild(b); b.$Bgx = 280; b.$Bgy = 120;
  const scale = 80 / 1638.4;
  const matrix = s.flash.geom.Matrix.axClass.axConstruct([scale, 0, 0, scale, 40, 40]);
  a.$Bggraphics.$BgbeginGradientFill('linear',s.createArray([0xff0000,0x0000ff]),
    s.createArray([1,1]),s.createArray([0,255]),matrix,'pad','rgb',0);
  a.$Bggraphics.$BgmoveTo(0,0);a.$Bggraphics.$BglineTo(80,0);
  a.$Bggraphics.$BglineTo(80,80);a.$Bggraphics.$BglineTo(0,80);
  a.$Bggraphics.$BglineTo(0,0);a.$Bggraphics.$BgendFill();
  a.adaptee.graphics.copyTo(b.adaptee.graphics);
  function frame() { player._renderer.render(); if (pixiLive.stats.lastError) throw Error(pixiLive.stats.lastError); }
  function sample(x,y) {
    const canvas=player._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');
    const gl=canvas.getContext('webgl2'),out=new Uint8Array(4),point=pixiLive.getDisplayObject(a).toGlobal({x,y});
    gl.readPixels(Math.floor(point.x),canvas.height-1-Math.floor(point.y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,out);
    return Array.from(out);
  }
  const pixels=()=>[sample(5,40),sample(40,40),sample(75,40)];
  try {
    pixiLiveControls.stop();await pixiLiveControls.enable({nativeGraphics:false,cacheScenery:false});
    frame();frame();const reference=pixels();
    pixiLiveControls.stop();await pixiLiveControls.enable({nativeGraphics:true,cacheScenery:false});
    frame();frame();
    const shape=pixiLive.getDisplayObject(a).children[0].children.find(c=>c.context);
    const copied=pixiLive.getDisplayObject(b).children[0].children.find(c=>c.context);
    if (!shape) throw Error('Linear gradient did not use Pixi Graphics');
    if(copied?.context!==shape.context)throw Error('Copied gradient did not share GraphicsContext');
    if(pixiLive.stats.nativeGradients!==2)throw Error('Expected two native gradient instances');
    const actual=pixels(),path=shape.context.instructions[0].data.style.fill;
    if (path?.type!=='linear') throw Error('Expected native Pixi FillGradient');
    let maxDelta=0;
    for(let i=0;i<actual.length;i++)for(let c=0;c<4;c++)
      maxDelta=Math.max(maxDelta,Math.abs(actual[i][c]-reference[i][c]));
    if (reference[0][0]<reference[0][2] || reference[2][2]<reference[2][0])
      throw Error('Reference gradient orientation was unexpected: '+JSON.stringify(reference));
    if(maxDelta>45)throw Error('Native linear gradient differs from mesh: '+JSON.stringify({reference,actual,maxDelta}));
    const context=shape.context,builds=pixiLive.stats.nativePathBuilds;
    a.$Bgx+=10;frame();
    const moved=pixiLive.getDisplayObject(a).children[0].children.find(c=>c.context);
    if(moved?.context!==context||pixiLive.stats.nativePathBuilds!==builds)
      throw Error('Moving a gradient rebuilt its shared context');
    return {reference,actual,maxDelta,reused:true,shared:true};
  } finally {
    g.$BgremoveChild(a);g.$BgremoveChild(b);for (const [n,v] of hidden) n.visible=v;frame();
  }
}
