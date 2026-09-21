// Run against a disposable Chrome with --remote-debugging-port=9234.
// Opens/closes its own page. Never logs in or sends game chat.
import assert from "node:assert/strict";
const endpoint = process.env.CDP_URL || "http://localhost:9234";
const target = await (
  await fetch(endpoint + "/json/new?about:blank", { method: "PUT" })
).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let next = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.id) {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  }
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
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
  throw Error("Timed out: " + expression);
}
async function compareComposition() {
  const result = await evaluate(`(async () => {
    const p = pixiLiveControls.player;
    const g = p._view.stage.context._gl;
    const paused = p.isPaused;
    p.isPaused = true;
    function sample() {
      const timings = [];
      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        p._renderer.render();
        g.finish();
        if (i > 1) timings.push(performance.now() - start);
      }
      const pixels = new Uint8Array(g.drawingBufferWidth * g.drawingBufferHeight * 4);
      g.readPixels(0, 0, g.drawingBufferWidth, g.drawingBufferHeight,
        g.RGBA, g.UNSIGNED_BYTE, pixels);
      return {
        pixels,
        medianMs: timings.sort((a, b) => a - b)[1],
        preparation: {...pixiLive.stats.preparation}
      };
    }
    try {
      pixiLiveControls.stop();
      await pixiLiveControls.enable({prepareOnly: false});
      const reference = sample();
      pixiLiveControls.stop();
      await pixiLiveControls.enable();
      const prepared = sample();
      let changed = 0, max = 0, sum = 0;
      for (let i = 0; i < reference.pixels.length; i += 4) {
        let pixelMax = 0;
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(reference.pixels[i+c] - prepared.pixels[i+c]);
          max = Math.max(max, d);
          pixelMax = Math.max(pixelMax, d);
          sum += d;
        }
        if (pixelMax > 3) changed++;
      }
      return {
        size: [g.drawingBufferWidth, g.drawingBufferHeight],
        pixelsDifferingOver3Percent: changed * 400 / reference.pixels.length,
        maxChannelError: max,
        meanChannelError: sum / (reference.pixels.length / 4 * 3),
        reference: {medianMs: reference.medianMs, preparation: reference.preparation},
        prepared: {medianMs: prepared.medianMs, preparation: prepared.preparation}
      };
    } finally {
      p.isPaused = paused;
    }
  })()`);
  assert.equal(result.maxChannelError, 0, "Pixi output changed when skipping AwayFL composition");
  assert.ok(result.prepared.preparation.skippedSceneDraws > 0);
  assert.ok(result.prepared.preparation.skippedComposites > 0);
  assert.ok(result.prepared.preparation.awayDraws < result.reference.preparation.awayDraws);
  return result;
}
const report = {};
try {
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Security.setIgnoreCertificateErrors", { ignore: true });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1000,
    height: 650,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", {
    url: "https://localhost:4433/game/gamefiles/pixi-benchmark/play.html?autostart=0",
  });
  await until(
    `(()=>{const p=window.pixiLiveControls?.player;return p?.root?._children?.some(n=>n.name==='scene'&&n._children.some(c=>c.name==='mcLogin'))})()`,
  );
  await evaluate(
    `window.testOriginal={render:pixiLiveControls.player._renderer.render,execute:pixiLiveControls.player._renderer.executeRender,flush:pixiLiveControls.player._renderer.flushBlendBackdrop,pause:pixiLiveControls.player.isPaused};window.testGL=pixiLiveControls.player._view.stage.context._gl;window.testHooks=Object.fromEntries(['bindTexture','getParameter','bufferData','bufferSubData','deleteTexture','getVertexAttrib','bindVertexArray','clear','drawArrays','drawElements'].map(k=>[k,testGL[k]]));pixiLiveControls.enable()`,
  );
  await until(
    "window.pixiLive?.stats.frames>=3 || window.pixiLive?.stats.lastError",
  );
  assert.equal(await evaluate("pixiLive.active"), true);
  // Use stage coordinates well inside the username field, away from its lock icon.
  const point = await evaluate(
    `(()=>{const c=testGL.canvas.getBoundingClientRect(),f=document.getElementById('player').getBoundingClientRect();return{x:f.x+c.x+c.width*480/960,y:f.y+c.y+c.height*220/550}})()`,
  );
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: type === "mouseMoved" ? "none" : "left",
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  await new Promise((r) => setTimeout(r, 600));
  for (const c of "pixi-probe") {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: c,
      text: c,
      unmodifiedText: c,
      windowsVirtualKeyCode: c.toUpperCase().charCodeAt(0),
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: c,
      windowsVirtualKeyCode: c.toUpperCase().charCodeAt(0),
    });
  }
  await until(
    `(()=>{let found=false;function walk(n){if(n.type==='input'&&n.name==='ni')found=n.text.endsWith('pixi-probe');for(const c of n._children||[])walk(c)}walk(pixiLiveControls.player.root);return found})()`,
  );
  report.mouseAndKeyboard = "passed";
  report.loginComposition = await compareComposition();
  await evaluate("pixiLiveControls.loadFixture().then(()=>true)");
  await until(
    "pixiLive.stats.scene?.commands>1000 || pixiLive.stats.lastError",
  );
  assert.equal(await evaluate("pixiLive.active"), true);
  report.fixture = await evaluate("JSON.parse(JSON.stringify(pixiLive.stats))");
  report.composition = await compareComposition();
  report.liveReadbacks = await evaluate(
    `(()=>{const g=testGL,old=g.readPixels;let count=0;g.readPixels=function(){count++;return old.apply(this,arguments)};try{for(let i=0;i<3;i++)pixiLiveControls.player._renderer.render();return count;}finally{g.readPixels=old;}})()`,
  );
  assert.equal(report.liveReadbacks, 0);
  report.resizes = [];
  for (const [width, height] of [
    [1200, 800],
    [800, 600],
  ]) {
    const before = await evaluate("pixiLive.stats.frames");
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await until(
      `pixiLive.stats.frames>${before + 2} || !!pixiLive.stats.lastError`,
    );
    assert.equal(await evaluate("pixiLive.active"), true);
    report.resizes.push(
      await evaluate(
        "({size:[testGL.drawingBufferWidth,testGL.drawingBufferHeight],error:testGL.getError(),lost:testGL.isContextLost()})",
      ),
    );
  }
  for (const r of report.resizes) {
    assert.equal(r.error, 0);
    assert.equal(r.lost, false);
  }
  report.resizedComposition = await compareComposition();
  await evaluate("pixiLiveControls.stop()");
  report.cleanup = await evaluate(
    `({render:pixiLiveControls.player._renderer.render===testOriginal.render,execute:pixiLiveControls.player._renderer.executeRender===testOriginal.execute,flush:pixiLiveControls.player._renderer.flushBlendBackdrop===testOriginal.flush,pause:pixiLiveControls.player.isPaused===testOriginal.pause,hooks:Object.entries(testHooks).every(([k,v])=>testGL[k]===v),lost:testGL.isContextLost()})`,
  );
  assert.deepEqual(report.cleanup, {
    render: true,
    execute: true,
    flush: true,
    pause: true,
    hooks: true,
    lost: false,
  });
  // Deliberate capture failure must return control to AwayFL and remove hooks.
  await evaluate(
    `window.testRead=testGL.getBufferSubData;testGL.getBufferSubData=()=>{throw Error('injected capture failure')};pixiLiveControls.enable()`,
  );
  await until("!!pixiLive.stats.lastError");
  report.failureRecovery = await evaluate(
    `({active:pixiLive.active,message:pixiLive.stats.lastError,restored:pixiLiveControls.player._renderer.render===testOriginal.render,hooks:Object.entries(testHooks).every(([k,v])=>testGL[k]===v)})`,
  );
  await evaluate("testGL.getBufferSubData=testRead");
  assert.equal(report.failureRecovery.active, false);
  assert.equal(report.failureRecovery.restored, true);
  assert.equal(report.failureRecovery.hooks, true);
  await evaluate("pixiLiveControls.enable()");
  await until("pixiLive.stats.frames>=3 || !!pixiLive.stats.lastError");
  assert.equal(await evaluate("pixiLive.active"), true);
  report.restart = "passed";
  await evaluate("pixiLiveControls.stop()");
  console.log(JSON.stringify(report, null, 2));
} finally {
  ws.close();
  await fetch(endpoint + "/json/close/" + target.id);
}
