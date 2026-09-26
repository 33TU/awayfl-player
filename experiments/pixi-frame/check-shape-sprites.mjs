// Disposable test tab: exercises shared rasterization without logging in.
import assert from 'node:assert/strict';
const endpoint = process.env.CDP_URL || 'http://localhost:9234';
const target = await (await fetch(endpoint + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (!m.id) return;
  const p = pending.get(m.id);
  pending.delete(m.id);
  m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  pending.set(++id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
try {
  await send('Runtime.enable');
  await send('Security.setIgnoreCertificateErrors', { ignore: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'https://localhost:4433/game/gamefiles/pixi-benchmark/play.html?autostart=0&renderScale=1&backend=direct-objects&nativeGraphics=1&shapeSprites=1' });
  const deadline = Date.now() + 60000;
  while (!(await evaluate('!!window.pixiLiveControls?.player?.root?._children.find(n=>n.name==="scene")?.adapter?.$BgmcLogin'))) {
    if (Date.now() > deadline) throw Error('Login scene timed out');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const result = await evaluate(`(async()=>{
    const p=pixiLiveControls.player;p.isPaused=true;
    await pixiLiveControls.enable();
    const scene=p.root._children.find(n=>n.name==='scene').adapter,s=scene.sec;
    const a=s.flash.display.Sprite.axClass.axConstruct([]),b=s.flash.display.Sprite.axClass.axConstruct([]);
    scene.$BgaddChild(a);scene.$BgaddChild(b);a.$Bgx=100;a.$Bgy=100;b.$Bgx=260;b.$Bgy=100;
    const draw=(obj,radius,clear=false)=>{
      const g=obj.$Bggraphics;if(clear)g.$Bgclear();g.$BgbeginFill(0x2266cc);
      for(let i=0;i<=96;i++){const t=i*Math.PI*2/96,x=50+Math.cos(t)*radius,y=50+Math.sin(t)*radius;
        if(i)g.$BglineTo(x,y);else g.$BgmoveTo(x,y)}g.$BgendFill();
    };
    draw(a,45);
    const pathSource=p._view.stage.context._gl.canvas.ownerDocument.defaultView.__PIXI_FLASH_PATHS__;
    const originalGet=pathSource.get,firstShape=a.adaptee.graphics.getShapeAt(0);
    const originalPath=originalGet(firstShape),authored=Object.freeze({...originalPath,rasterStable:true});
    pathSource.get=shape=>{const path=originalGet(shape);return path===originalPath?authored:path};
    p._renderer.render();
    a.adaptee.graphics.copyTo(b.adaptee.graphics);
    p._renderer.render();
    const sprite=obj=>pixiLive.getDisplayObject(obj).children[0].children.find(c=>c.renderPipeId==='sprite');
    const first=sprite(a),second=sprite(b),shared=!!first&&!!second&&first.texture===second.texture;
    const canvas=p._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]'),gl=canvas.getContext('webgl2');
    const point=pixiLive.getDisplayObject(a).toGlobal({x:50,y:50}),pixel=new Uint8Array(4);
    gl.readPixels(Math.floor(point.x),canvas.height-1-Math.floor(point.y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    const builds=pixiLive.stats.shapeSpriteBuilds,uses=pixiLive.stats.shapeSpriteUses;
    a.$Bgx+=3;p._renderer.render();
    const stable=builds===pixiLive.stats.shapeSpriteBuilds&&first===sprite(a);
    const sample=(x,y)=>{const pnt=pixiLive.getDisplayObject(a).toGlobal({x,y}),v=new Uint8Array(4);
      gl.readPixels(Math.floor(pnt.x),canvas.height-1-Math.floor(pnt.y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,v);
      return Array.from(v)};
    a.$Bgvisible=false;b.$Bgvisible=false;p._renderer.render();
    const background=sample(93,50);
    a.$Bgvisible=true;b.$Bgvisible=true;p._renderer.render();
    draw(a,40,true);p._renderer.render();
    const dynamicFallback=originalGet(a.adaptee.graphics.getShapeAt(0))?.rasterStable===false;
    const cleared=sample(93,50);
    const report={shared,stable,dynamicFallback,builds,uses,pixel:Array.from(pixel),background,cleared,error:pixiLive.stats.lastError,
      config:pixiLive.stats.configuration.shapeSprites,pixels:pixiLive.stats.shapeSpritePixels,
      afterEdit:{builds:pixiLive.stats.shapeSpriteBuilds}};
    pathSource.get=originalGet;
    scene.$BgremoveChild(a);scene.$BgremoveChild(b);p._renderer.render();
    p.isPaused=false;
    await pixiLiveControls.loadFixture({drawBitmap:false});
    p.isPaused=true;
    p._renderer.render();
    report.fixture={builds:pixiLive.stats.shapeSpriteBuilds,uses:pixiLive.stats.shapeSpriteUses,
      pixels:pixiLive.stats.shapeSpritePixels,error:pixiLive.stats.lastError};
    pixiLiveControls.stop();
    return report;
  })()`);
  console.log(JSON.stringify(result));
  assert.equal(result.error, null);
  assert.equal(result.config, true);
  assert.equal(result.shared, true, 'instances must share one generated texture');
  assert.equal(result.stable, true, 'transform must reuse the texture');
  assert.equal(result.dynamicFallback, true, 'a redrawn path must stay vector-backed');
  assert.ok(result.background.every((channel,i)=>Math.abs(channel-result.cleared[i])<=2),
    'old rasterized shape must disappear after Graphics.clear()');
  assert.ok(result.pixel.every((channel, i) => Math.abs(channel - [34,102,204,255][i]) <= 2),
    'generated sprite must retain the authored solid fill');
  assert.ok(result.builds >= 1 && result.uses >= 2 && result.pixels > 0);
  assert.equal(result.fixture.error, null, 'game fixture must render without Pixi errors');
  assert.ok(result.fixture.builds > result.builds, 'game fixture should exercise shared shape textures');
} finally {
  await send('Page.close').catch(() => {});
  ws.close();
}
