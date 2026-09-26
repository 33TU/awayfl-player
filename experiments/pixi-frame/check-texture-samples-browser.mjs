// Disposable test tab only. No authentication, server selection or game chat.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
const endpoint = process.env.CDP_URL || "http://localhost:9234";
const target = await (
  await fetch(endpoint + "/json/new?about:blank", { method: "PUT" })
).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let id = 0;
const pending = new Map(),
  errors = [];
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
  } else if (m.method === "Runtime.consoleAPICalled") {
    const message = m.params.args
      .map((a) => a.value ?? a.description)
      .join(" ");
    if (
      message.includes("[Pixi display list]") || message.includes("[Pixi live]") ||
      message.includes("Could not initialize shader") ||
      message.includes("gl.getProgramInfoLog") ||
      (message.includes("textureSource") && message.includes("destroyed"))
    )
      errors.push(message);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    pending.set(++id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails)
    throw Error(
      r.exceptionDetails.exception?.description || r.exceptionDetails.text,
    );
  return r.result.value;
}
async function until(expression) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error("Timeout: " + expression);
}
try {
 await send('Runtime.enable');await send('Security.setIgnoreCertificateErrors',{ignore:true});
 await send('Emulation.setDeviceMetricsOverride',{width:700,height:480,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:'https://localhost:4433/game/gamefiles/pixi-benchmark/play.html?autostart=0&renderScale=1&backend=direct-objects'});
 await until('!!window.pixiLiveControls?.player?.root?._children.find(n=>n.name==="scene")?.adapter?.$BgmcLogin');
 const report=await evaluate(`(async()=>{
  const p=pixiLiveControls.player;p.isPaused=true;
  await pixiLiveControls.enable({cacheScenery:false});
  const g=p.root._children.find(n=>n.name==='scene').adapter,s=g.sec;
  const hidden=g.adaptee._children.map(n=>[n,n.visible]);for(const [n]of hidden)n.visible=false;
  const make=()=>s.flash.display.Sprite.axClass.axConstruct([]);
  const parent=make(),writer=make();g.$BgaddChild(parent);g.$BgaddChild(writer);writer.$Bgx=-500;
  const shapes=[];
  for(let i=0;i<80;i++){
   const c=make();parent.$BgaddChild(c);shapes.push(c);c.$Bgx=10+(i%10)*25;c.$Bgy=10+Math.floor(i/10)*25;
   c.$Bggraphics.$BgbeginFill(0x223311+i*101,i%2?0.5:1);c.$Bggraphics.$BgdrawRect(0,0,20,20);c.$Bggraphics.$BgendFill();
  }
  function frame(){p._renderer.render();if(pixiLive.stats.lastError)throw Error(pixiLive.stats.lastError);}
  function read(){const canvas=p._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');const gl=canvas.getContext('webgl2'),data=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);return data;}
  function delta(a,b){let max=0;for(let i=0;i<a.length;i++)max=Math.max(max,Math.abs(a[i]-b[i]));return max;}
  frame();frame();frame();const initial=read();
  writer.$Bggraphics.$BgbeginFill(0x514367);writer.$Bggraphics.$BgdrawRect(0,0,10,10);writer.$Bggraphics.$BgendFill();
  frame();frame();const prepared=pixiLive.stats.preparedContents,afterAppend=read();
  let source;
  shapes[0].adaptee.getEntity()._acceptTraverser({applyTraversable(shape){
   const material=shape.material,tex=material.getTextureAt(0),style=shape.style;
   source={image:style?.getImageAt?.(tex)||material.style?.getImageAt?.(tex)||tex.getImageAt(0),uv:style?.uvMatrix||material.style?.uvMatrix};
  }});
  const at=((source.uv.ty*source.image.height-0.5)*source.image.width+source.uv.tx*source.image.width-0.5)*4;
  source.image._data[at]=255;source.image._data[at+1]=0;source.image._data[at+2]=255;source.image.invalidateGPU();
  frame();const edited=read(),editedPrepared=pixiLive.stats.preparedContents;
  pixiLiveControls.stop();await pixiLiveControls.enable({cacheScenery:false,sampledTextures:false});frame();frame();const reference=read();
  const out={prepared,editedPrepared,appendPixelDelta:delta(initial,afterAppend),editedPixelDelta:delta(initial,edited),referencePixelDelta:delta(edited,reference)};
  for(const [n,v]of hidden)n.visible=v;g.$BgremoveChild(parent);g.$BgremoveChild(writer);
  return out;
 })()`);
 console.log(JSON.stringify(report));
 assert.equal(report.appendPixelDelta,0,'unrelated palette append changes no visible pixels');
 assert.ok(report.editedPixelDelta>0,'editing a sampled pixel must change rendered pixels');
 assert.equal(report.referencePixelDelta,0,'sampled dependencies match full-image reference');
 assert.ok(report.prepared<10,'palette append must retain existing 80 fills');
 assert.ok(report.editedPrepared<10,'sampled edit only prepares affected fills');
 assert.deepEqual(errors,[]);
}finally{await send('Page.close').catch(()=>{});ws.close();}
