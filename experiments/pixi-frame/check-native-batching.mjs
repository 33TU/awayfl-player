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
  await send("Runtime.enable");
  await send("Security.setIgnoreCertificateErrors",{ignore:true});
  await send("Emulation.setDeviceMetricsOverride",{width:1100,height:760,deviceScaleFactor:1,mobile:false});
  await send("Page.navigate",{url:'https://localhost:4433/game/gamefiles/pixi-benchmark/play.html?autostart=0&renderScale=1&backend=direct-objects&nativeGraphics=1'});
  await until('!!window.pixiLiveControls?.player?.root?._children.find(n=>n.name==="scene")?.adapter?.$BgmcLogin');
  const report=await evaluate(`(async()=>{
    const p=pixiLiveControls.player;p.isPaused=true;await pixiLiveControls.enable();p.isPaused=false;
    const f=await pixiLiveControls.loadFixture();p.isPaused=true;
    f.map.adaptee._children[0].visible=true;f.map.adaptee._children[1].visible=false;
    const g=p.root._children.find(n=>n.name==='scene').adapter;
    const marker=g.sec.flash.display.Sprite.axClass.axConstruct([]);g.$BgaddChild(marker);
    let reference;const results=[];
    for(const nativeBatching of [false,true]) {
      pixiLiveControls.stop();await pixiLiveControls.enable({cacheScenery:false,nativeBatching});
      for(let i=0;i<3;i++)p._renderer.render();
      const canvas=p._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');
      const gl=canvas.getContext('webgl2');const saved={};let draws=0,uploadBytes=0;
      for(const name of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']) {
        saved[name]=gl[name];gl[name]=function(...args){draws++;return saved[name].apply(this,args);};
      }
      try {marker.$Bgx++;p._renderer.render();}
      finally {for(const [name,fn] of Object.entries(saved))gl[name]=fn;}
      const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      let maxDelta=0,changed=0,total=0;
      if(reference)for(let i=0;i<pixels.length;i++){const d=Math.abs(pixels[i]-reference[i]);maxDelta=Math.max(maxDelta,d);changed+=d>16;total+=d;}
      else reference=pixels;
      results.push({nativeBatching,draws,maxDelta,changed,total,nativeGraphics:pixiLive.stats.nativeGraphics});
    }
    for(const result of results) {
      pixiLiveControls.stop();await pixiLiveControls.enable({cacheScenery:false,nativeBatching:result.nativeBatching});
      for(let i=0;i<3;i++)p._renderer.render();
      const sample=pixiLive.profile(3);
      for(let i=0;i<3;i++){p.isPaused=false;p.showNextFrame(1000/24);p.isPaused=true;}
      result.median=(await sample).median;
    }
    g.$BgremoveChild(marker);return results;
  })()`);
  console.log(JSON.stringify(report,null,2));
  await writeFile('/tmp/pixi-native-batching-check.json',JSON.stringify(report,null,2));
  assert.deepEqual(errors,[]);
  assert.ok(report[1].draws<report[0].draws,'default-compatible shapes should reduce draws');
  assert.ok(report[1].maxDelta<=1,'shared default batches must preserve rendered pixels');
} finally {await send('Page.close').catch(()=>{});ws.close();}
