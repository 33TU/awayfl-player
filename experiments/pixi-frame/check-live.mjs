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
const destroyedTextureWarnings = [];
ws.onmessage = ({ data }) => {
  const m = JSON.parse(data);
  if (m.method === "Runtime.consoleAPICalled") {
    const message = m.params.args
      .map((a) => a.value ?? a.description)
      .join(" ");
    if (message.includes("textureSource") && message.includes("destroyed"))
      destroyedTextureWarnings.push(message);
  }
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
async function compareComposition({
  sourceOnly = false,
  rebuild = false,
} = {}) {
  const result = await evaluate(`(async () => {
    const p = pixiLiveControls.player;
    const g = p._view.stage.context._gl;
    const paused = p.isPaused;
    p.isPaused = true;
    function invalidateCaches() {
      function walk(n) {
        for (const r of Object.values(n._renderObjects || {}))
          if (r.assetType === '[renderer CacheRenderer]') r.onInvalidate();
        for (const c of n._children || []) walk(c);
      }
      walk(p.root);
    }
    function sample() {
      const timings = [];
      for (let i = 0; i < 5; i++) {
        if (${rebuild}) invalidateCaches();
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
        preparation: {...pixiLive.stats.preparation}, filters: {...pixiLive.stats.filters}
      };
    }
    try {
      pixiLiveControls.stop();
      await pixiLiveControls.enable(${JSON.stringify(sourceOnly ? { cachedLayers: false } : { prepareOnly: true, directScene: false, pixiFilters: false })});
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
        prepared: {medianMs: prepared.medianMs, preparation: prepared.preparation, filters: prepared.filters}
      };
    } finally {
      p.isPaused = paused;
    }
  })()`);
  assert.ok(
    result.maxChannelError <= 1,
    "Pixi geometry/filter/source migration changed output: " +
      JSON.stringify(result),
  );
  assert.ok(result.prepared.preparation.directMeshes > 0);
  assert.ok(result.prepared.preparation.sourceMeshes > 0);
  assert.deepEqual(result.prepared.preparation.sourceFallbacks, {});
  assert.ok(result.prepared.preparation.pixiFilterPasses > 0);
  assert.ok(result.prepared.preparation.skippedComposites > 0);
  assert.equal(result.prepared.preparation.skippedSceneDraws, 0);
  assert.deepEqual(result.prepared.preparation.directFallbacks, {});
  assert.ok(
    result.prepared.preparation.awayDraws <=
      result.reference.preparation.awayDraws,
  );
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
  assert.ok(report.fixture.direct.geometryHits > 0);
  report.composition = await compareComposition();
  assert.ok(report.composition.prepared.preparation.sourceMaskMeshes > 0);
  assert.ok(report.composition.prepared.preparation.sourceCacheQuads > 0);
  report.rebuiltSources = await compareComposition({
    sourceOnly: true,
    rebuild: true,
  });
  report.liveReadbacks = await evaluate(
    `(()=>{const g=testGL,old=g.readPixels;let count=0;g.readPixels=function(){count++;return old.apply(this,arguments)};try{for(let i=0;i<3;i++)pixiLiveControls.player._renderer.render();return count;}finally{g.readPixels=old;}})()`,
  );
  assert.equal(report.liveReadbacks, 0);
  report.liveErrorPolls = await evaluate(
    `(()=>{const g=testGL,old=g.getError;let count=0;g.getError=function(){count++;return old.apply(this,arguments)};try{for(let i=0;i<3;i++)pixiLiveControls.player._renderer.render();return count;}finally{g.getError=old;}})()`,
  );
  assert.equal(report.liveErrorPolls, 0);
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
    `window.testRead=testGL.getBufferSubData;testGL.getBufferSubData=()=>{throw Error('injected capture failure')};pixiLiveControls.enable({directScene:false})`,
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
  assert.equal(
    await evaluate("pixiLive.active"),
    true,
    await evaluate("JSON.stringify(pixiLive.stats)"),
  );
  report.restart = "passed";
  // Interrupt an actual Pixi source draw, identified by its unadapted material
  // shader, and verify that native rendering can resume on the same target.
  report.sourceFailureRecovery = await evaluate(`(()=>{
    const p=pixiLiveControls.player, g=testGL, draw=g.drawArrays, paused=p.isPaused;
    p.isPaused=true;
    let injected=false;
    g.drawArrays=function(){
      if(!injected) {
        const program=g.getParameter(g.CURRENT_PROGRAM);
        const vertex=g.getAttachedShaders(program).find(s=>g.getShaderParameter(s,g.SHADER_TYPE)===g.VERTEX_SHADER);
        const text=g.getShaderSource(vertex);
        if (/uniform\\s+vec4\\s+vc\\[/.test(text) && !text.includes('uAwayViewport')) {
          injected=true;throw Error('injected source draw failure');
        }
      }
      return draw.apply(this,arguments);
    };
    try {p._renderer.render();}
    finally {g.drawArrays=draw;p.isPaused=paused;}
    return {injected,active:pixiLive.active,message:pixiLive.stats.lastError,
      restored:p._renderer.render===testOriginal.render,
      hooks:Object.entries(testHooks).every(([k,v])=>g[k]===v),error:g.getError()};
  })()`);
  assert.equal(report.sourceFailureRecovery.injected, true);
  assert.equal(report.sourceFailureRecovery.active, false);
  assert.equal(
    report.sourceFailureRecovery.message,
    "injected source draw failure",
  );
  assert.equal(report.sourceFailureRecovery.restored, true);
  assert.equal(report.sourceFailureRecovery.hooks, true);
  assert.equal(report.sourceFailureRecovery.error, 0);
  await evaluate("pixiLiveControls.enable()");
  await until("pixiLive.stats.frames>=3 || !!pixiLive.stats.lastError");
  assert.equal(await evaluate("pixiLive.active"), true);
  await evaluate("pixiLiveControls.stop()");
  report.filters = await evaluate(
    `import('./check-filter-browser.js?v='+Date.now()).then(m=>m.checkFilters(pixiLiveControls.player))`,
  );
  assert.equal(report.filters.glError, 0);
  assert.equal(report.filters.fallback, 0);
  assert.ok(report.filters.stats.blur > 0 && report.filters.stats.shadow > 0);
  for (const test of report.filters.results)
    assert.equal(test.max, 0, test.name);
  await evaluate("pixiLiveControls.enable()");
  await until("pixiLive.stats.frames>=3 || !!pixiLive.stats.lastError");
  assert.equal(
    await evaluate("pixiLive.active && testGL.getError()===0"),
    true,
  );
  await evaluate("pixiLiveControls.stop()");
  report.renderer = await evaluate(
    `import('./check-filter-browser.js?v='+Date.now()).then(m=>m.checkRenderer(pixiLiveControls.player))`,
  );
  assert.equal(report.renderer.glError, 0);
  assert.deepEqual(report.renderer.scopedState, {
    switches: 3,
    active: true,
    highBinding: true,
    lowBindings: [true, true],
  });
  for (const key of [
    "retained",
    "released",
    "destroyedOnStop",
    "nativeTextureSurvives",
  ])
    assert.equal(report.renderer[key], true, key);
  for (const mask of report.renderer.masks) {
    assert.deepEqual(mask.pixels, [
      [51, 51, 51, 255],
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ]);
    assert.equal(mask.writeMask, 0);
    assert.equal(mask.backWriteMask, 0);
    assert.equal(mask.clear, 7);
    assert.equal(mask.test, true);
  }
  report.flashBlends = await evaluate(
    `import('./check-filter-browser.js?v='+Date.now()).then(m=>m.checkFlashBlend(pixiLiveControls.player))`,
  );
  assert.equal(report.flashBlends.glError, 0);
  for (const result of report.flashBlends.results) {
    assert.equal(result.active, true);
    assert.equal(result.lastError, null);
    assert.ok(result.overlays > 0);
    for (let i = 0; i < 4; i++)
      assert.ok(
        Math.abs(result.expected[i] - result.actual[i]) <= 1,
        JSON.stringify(result),
      );
  }
  report.destroyedTextureWarnings = destroyedTextureWarnings;
  assert.deepEqual(destroyedTextureWarnings, []);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(JSON.stringify(report, null, 2));
  throw error;
} finally {
  ws.close();
  await fetch(endpoint + "/json/close/" + target.id);
}
