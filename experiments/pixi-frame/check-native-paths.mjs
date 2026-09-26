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
  await send("Security.setIgnoreCertificateErrors", { ignore: true });
  await send("Emulation.setDeviceMetricsOverride", {width:1100,height:760,deviceScaleFactor:1,mobile:false});
  // Exercise opt-out on the regular runtime too: `false?.get()` still calls
  // an absent method, so a native-only fixture would miss this startup crash.
  await send("Page.navigate", {url:'https://localhost:4433/game/gamefiles/pixi-benchmark/play.html?autostart=0&renderScale=1&backend=direct-objects'});
  await until('!!window.pixiLiveControls?.player?.root?._children.find(n=>n.name==="scene")?.adapter?.$BgmcLogin');
  const disabled=await evaluate(`(async()=>{
    const p=pixiLiveControls.player;p.isPaused=true;const result=[];
    for(const backend of ['direct-objects','display-list']) {
      await pixiLiveControls.enable({backend});
      for(let i=0;i<3;i++)p._renderer.render();
      result.push({backend,active:pixiLive.active,error:pixiLive.stats.lastError,meshes:pixiLive.stats.meshes,native:pixiLive.stats.nativeGraphics});
      pixiLiveControls.stop();
    }
    return result;
  })()`);
  for(const mode of disabled) {
    assert.equal(mode.error,null);assert.equal(mode.active,true);
    assert.ok(mode.meshes>0);assert.equal(mode.native,0);
  }
  await send("Page.navigate", {url:'https://localhost:4433/game/gamefiles/pixi-benchmark/play.html?autostart=0&renderScale=1&backend=direct-objects&nativeGraphics=1'});
  await until('!!window.pixiLiveControls?.player?.root?._children.find(n=>n.name==="scene")?.adapter?.$BgmcLogin');
  const report=await evaluate(`(async()=>{
    const p=pixiLiveControls.player;p.isPaused=true;
    await pixiLiveControls.enable();p._renderer.render();
    const login=structuredClone(pixiLive.stats);
    const f=await import('./check-filter-browser.js');
    return {login,test:await f.checkNativePaths(p,pixiLive),
      text:await f.checkNativeText(p,pixiLive),
      gradient:await f.checkLinearGradient(p),
      radial:await f.checkRadialGradient(p),
      bitmap:await f.checkBitmapFill(p),
      compound:await f.checkCompoundFill(p)};
  })()`);
  assert.equal(report.login.lastError,null);
  assert.ok(report.login.nativeGraphics>0);
  report.deferred=await evaluate(`(async()=>{
    const p=pixiLiveControls.player,source=p._view.stage.context._gl.canvas.ownerDocument.defaultView.__PIXI_FLASH_PATHS__;
    const before={...source.lazyStats};
    p.isPaused=false;
    const fixture=await pixiLiveControls.loadFixture({drawBitmap:false});
    p.isPaused=true;
    for(let i=0;i<3;i++)p._renderer.render();
    const retained={...source.lazyStats};
    fixture.drawBitmap();
    const after={...source.lazyStats};
    p.isPaused=false;
    await pixiLiveControls.loadFixture({drawBitmap:false});
    p.isPaused=true;
    for(let i=0;i<3;i++)p._renderer.render();
    const beforeStop={...source.lazyStats};
    pixiLiveControls.stop();
    return {before,retained,after,beforeStop,restored:{...source.lazyStats}};
  })()`);
  assert.ok(report.deferred.after.skipped>report.deferred.before.skipped,
    'Battleon authored paths bypass native tessellation');
  assert.ok(report.deferred.retained.live>0,
    'Battleon keeps authored paths deferred while Pixi renders them');
  assert.ok(report.deferred.retained.liveStrokes>0,
    'Battleon keeps authored strokes deferred while Pixi renders them');
  assert.ok(report.deferred.after.materialized>report.deferred.before.materialized,
    'BitmapData.draw materializes deferred native triangles');
  assert.ok(report.deferred.beforeStop.live>0,
    'fresh authored paths remain deferred until renderer switch');
  assert.equal(report.deferred.restored.live,0,
    'switching to AwayFL materializes remaining deferred triangles');
  assert.equal(report.deferred.restored.liveStrokes,0,
    'switching to AwayFL materializes remaining deferred lines');
  assert.ok(report.deferred.restored.materialized>report.deferred.after.materialized,
    'renderer switch materializes remaining deferred triangles');
  report.disabled=disabled;
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify(report,null,2));
  await writeFile('/tmp/pixi-native-paths-check.json',JSON.stringify(report,null,2));
} finally {await send('Page.close').catch(()=>{});ws.close();}
