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
const directObjects = process.env.PIXI_BACKEND === "direct-objects";
const idleHoverHz = Number(process.env.PIXI_IDLE_HOVER_HZ || 0);
const pixiPickBounds = process.env.PIXI_PICK_BOUNDS === '1';
const pixiEvents = process.env.PIXI_EVENTS === '1';
const nativeGraphics = process.env.PIXI_NATIVE_GRAPHICS === '1';
const catchUp = process.env.PIXI_CATCH_UP === '1';
const report = {};
try {
  await send("Runtime.enable");
  await send("Security.setIgnoreCertificateErrors", { ignore: true });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1100,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", {
    url: `https://localhost:4433/game/gamefiles/pixi-benchmark/play.html?autostart=0&renderScale=0&backend=${directObjects ? "direct-objects" : "display-list"}&idleHoverHz=${idleHoverHz}&pixiPickBounds=${+pixiPickBounds}&pixiEvents=${+pixiEvents}&nativeGraphics=${+nativeGraphics}&catchUp=${+catchUp}`,
  });
  await until(
    '!!window.pixiLiveControls?.player?.root?._children.find(n=>n.name==="scene")?.adapter?.$BgmcLogin',
  );
  report.login = await evaluate(`(async()=>{
    const p=pixiLiveControls.player;p.isPaused=true;
    window.originalRootRender=p._renderer.render;
    window.originalObjectHooks=[p.root._invalidateHierarchicalProperty,p.root._setParent,p.root.addChildAt,p.root.invalidate,p.root._invalidateStyle,p.root._invalidateMaterial,p.root.invalidateElements];
    p._renderer.render=()=>{throw Error('AwayFL root renderer called by direct display list')};
    await pixiLiveControls.enable();
    for(let i=0;i<5;i++)p._renderer.render();
    const builds=pixiLive.stats.geometryBuilds,uploads=pixiLive.stats.textureUploads,uniforms=pixiLive.stats.uniformUpdates;
    for(let i=0;i<5;i++)p._renderer.render();
    return {stats:structuredClone(pixiLive.stats),geometryReused:builds===pixiLive.stats.geometryBuilds,texturesReused:uploads===pixiLive.stats.textureUploads,uniformsReused:uniforms===pixiLive.stats.uniformUpdates};
  })()`);
  if (directObjects) assert.equal(report.login.stats.retainedHover, true);
  if (catchUp) assert.equal(report.login.stats.configuration.catchUp, true);
  if (pixiEvents) assert.equal(report.login.stats.configuration.pixiEvents, true);
  report.nullFilter = await evaluate(`(()=>{
    const p=pixiLiveControls.player,node=p.root._children.find(n=>n.name==='scene'),old=node.filters;
    try {
      node.filters=[null];
      p._renderer.render();
      return node.filters?.length===1 && pixiLive.stats.lastError===null;
    } finally { node.filters=old; p._renderer.render(); }
  })()`);
  assert.equal(report.nullFilter,true,"null Flash filter slots must not pause Pixi rendering");
  if (directObjects) {
    report.directObjects = await evaluate(`(()=>{
      const p=pixiLiveControls.player,g=p.root._children.find(n=>n.name==='scene').adapter,s=g.sec;
      const parent=s.flash.display.Sprite.axClass.axConstruct([]),other=s.flash.display.Sprite.axClass.axConstruct([]);
      const a=s.flash.display.Sprite.axClass.axConstruct([]),b=s.flash.display.Sprite.axClass.axConstruct([]);
      g.$BgaddChild(parent);g.$BgaddChild(other);parent.$BgaddChild(a);parent.$BgaddChild(b);
      const pa=pixiLive.getDisplayObject(a),pb=pixiLive.getDisplayObject(b);
      const created=!!pa&&!!pb;
      a.$Bgx=123;a.$Bgy=45;a.$BgscaleX=2;
      const immediate=[pa.position.x,pa.position.y,pa.scale.x];
      parent.$BgsetChildIndex(a,1);
      const reordered=pa.parent.children[1]===pa;
      other.$BgaddChild(a);const reparented=pa.parent!==pb.parent;
      other.$BgremoveChild(a);const removed=pa.parent===null;
      parent.$BgaddChild(a);const retained=pixiLive.getDisplayObject(a)===pa;
      a.$Bgvisible=false;const visibility=pa.visible===false;a.$Bgvisible=true;
      p._renderer.render();const before=pixiLive.stats.directTransformUpdates;
      for(let i=0;i<4;i++)p._renderer.render();
      const stable=before===pixiLive.stats.directTransformUpdates;
      const idlePrepared=pixiLive.stats.preparedNodes;
      const totalNodes=pixiLive.stats.nodes;
      a.$Bgx=124;p._renderer.render();
      const changedPrepared=pixiLive.stats.preparedNodes,skipped=pixiLive.stats.skippedSubtrees;
      g.$BgremoveChild(parent);g.$BgremoveChild(other);
      for(let i=0;i<5;i++)p._renderer.render();
      const retired=!pixiLive.getDisplayObject(a)&&pa.destroyed;
      g.$BgaddChild(parent);p._renderer.render();
      const readopted=!!pixiLive.getDisplayObject(a)&&pixiLive.getDisplayObject(a)!==pa;
      g.$BgremoveChild(parent);
      return {retired,readopted,created,immediate,reordered,reparented,removed,retained,visibility,stable,idlePrepared,totalNodes,changedPrepared,skipped,polled:pixiLive.stats.polledTransforms};
    })()`);
    assert.deepEqual(report.directObjects.immediate,[123,45,2]);
    for(const key of ['created','reordered','reparented','removed','retained','visibility','stable','retired','readopted'])
      assert.equal(report.directObjects[key],true,key);
    assert.equal(report.directObjects.polled,0);
    assert.equal(report.directObjects.idlePrepared,0,"idle frames skip all preparation");
    assert.ok(report.directObjects.changedPrepared>0);
    assert.ok(report.directObjects.changedPrepared<report.directObjects.totalNodes/2,"local changes skip unrelated branches");
    assert.ok(report.directObjects.skipped>0);
    report.maskUpdates = await evaluate(`(async()=>{
      const {checkMaskUpdates}=await import('./check-filter-browser.js?v='+Date.now());
      return checkMaskUpdates(pixiLiveControls.player,pixiLive);
    })()`);
    assert.ok(report.maskUpdates.localMaskUpdates>0);
    report.colorUpdates = await evaluate(`(async()=>{
      const {checkColorUpdates}=await import('./check-filter-browser.js?v='+Date.now());
      return checkColorUpdates(pixiLiveControls.player,pixiLive);
    })()`);
    assert.ok(report.colorUpdates.unchangedColorUpdates>=4);
    report.translationReuse = await evaluate(`(async()=>{
      const {checkTranslationReuse}=await import('./check-filter-browser.js?v='+Date.now());
      return checkTranslationReuse(pixiLiveControls.player,pixiLive);
    })()`);
    for(const c of report.translationReuse.cases){
      if(['child-color','child-text','child-remove','child-reattach'].includes(c.name)) {
        assert.ok(c.retainedContents>0,c.name+' retains ancestor content');
        assert.ok(c.preparedContents<c.forcedContents,c.name+' prepares less content');
      }
      assert.equal(c.maxDelta,0,c.name);
      if(['translate','fractional'].includes(c.name))assert.ok(c.retainedPrepared<c.forcedPrepared/2,c.name+' skips descendants');
      if(c.name==='color')assert.ok(c.retainedPrepared>=64,c.name+' updates descendants');
      // Scale/rotate re-prepare only transform-sensitive descendants (the glow and
      // text here); plain and normal-stroke children follow the Pixi transform.
      if(['scale','rotate'].includes(c.name))assert.ok(c.retainedPrepared<c.forcedPrepared,c.name+' retains transform-insensitive descendants');
    }

  }
  assert.equal(report.login.stats.active, true);
  assert.equal(report.login.stats.lastError, null);
  assert.equal(report.login.stats.mode, directObjects ? "direct-objects" : "display-list");
  assert.ok(report.login.stats.meshes > 100);
  assert.equal(report.login.geometryReused, true);
  assert.equal(report.login.texturesReused, true);
  assert.equal(report.login.uniformsReused, true);
  assert.ok(
    report.login.stats.reusedFrames >= 8,
    "unchanged login frames reuse the canvas",
  );
  assert.ok(
    report.login.stats.drawnFrames <= 2,
    "unchanged login avoids full-scene draws",
  );
  await evaluate("pixiLiveControls.player.isPaused=false");
  const point = await evaluate(
    `(()=>{const c=pixiLiveControls.player._view.stage.context._gl.canvas.getBoundingClientRect(),f=document.getElementById('player').getBoundingClientRect();return{x:f.x+c.x+c.width*480/960,y:f.y+c.y+c.height*220/550}})()`,
  );
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: type === "mouseMoved" ? "none" : "left",
      clickCount: type === "mouseMoved" ? 0 : 1,
    });
  await new Promise((r) => setTimeout(r, 500));
  for (const c of "pixi-test") {
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
    `(()=>{let found=false;function walk(n){if(n.type==='input'&&n.name==='ni')found=n.text.endsWith('pixi-test');for(const c of n._children||[])walk(c)}walk(pixiLiveControls.player.root);return found})()`,
  );
  report.mouseAndKeyboard = "passed";
  await evaluate("pixiLiveControls.player.isPaused=true");
  report.clearedFocus = await evaluate(`(()=>{
    const manager=pixiLiveControls.player._mouseManager,previous=manager._focusNode;
    manager._focusNode={_asset:null,get container(){throw Error('cleared focus asset was read')}};
    try { manager.setFocus(null); return manager._focusNode===null; }
    finally { manager._focusNode=previous; }
  })()`);
  assert.equal(report.clearedFocus,true,"cleared focus nodes must not be dereferenced");
  if (idleHoverHz) {
    report.idleHover = await evaluate(`(async()=>{
      const p=pixiLiveControls.player,m=p._mouseManager,s=pixiLive.stats;
      if(s.idleHoverHz!==${idleHoverHz})throw Error('Hover option not enabled');
      const skipped=s.hoverSkips;
      for(let i=0;i<8;i++)m.fireMouseEvents(p._mousePicker);
      const idleSkips=s.hoverSkips-skipped;
      await new Promise(r=>setTimeout(r,1000/${idleHoverHz}+5));
      const checked=s.hoverChecks;
      m.fireMouseEvents(p._mousePicker);
      return {hz:s.idleHoverHz,idleSkips,periodicCheck:s.hoverChecks===checked+1};
    })()`);
    assert.ok(report.idleHover.idleSkips>=7);
    assert.equal(report.idleHover.periodicCheck,true,'stationary hover still checks animated targets');
  }
  // Use the actual avatar shadow: a thin ellipse with a broad one-pass blur.
  // At large scale, widely spaced Gaussian samples used to form repeated ovals.
  report.avatarShadow = await evaluate(`(()=>{
    const p=pixiLiveControls.player,g=p.root._children.find(n=>n.name==='scene').adapter,s=g.sec;
    const visibility=g.adaptee._children.map(n=>[n,n.visible]);for(const [n] of visibility)n.visible=false;
    const bg=s.flash.display.Sprite.axClass.axConstruct([]);
    bg.$Bggraphics.$BgbeginFill(0xffffff);bg.$Bggraphics.$BgdrawRect(0,0,960,550);bg.$Bggraphics.$BgendFill();g.$BgaddChild(bg);
    const avatar=g.$BgloaderInfo.$BgapplicationDomain.$BggetDefinition('AvatarMC').axConstruct([false]);
    g.$BgaddChild(avatar);avatar.$Bgx=450;avatar.$Bgy=300;avatar.$BgscaleX=avatar.$BgscaleY=4;
    for(const c of avatar.adaptee._children)c.visible=c.name==='shadow';
    const canvas=p._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]'),gl=canvas.getContext('webgl2');
    function profile(){p._renderer.render();const pt=g.$BglocalToGlobal(new s.flash.geom.Point(450,300)),m=p._view.viewMatrix3D._rawData;
      const x=Math.floor(canvas.width*.5*(1+(m[0]*pt.$Bgx+m[4]*pt.$Bgy+m[12])/m[15]));
      const y=Math.floor(canvas.height*.5*(1-(m[1]*pt.$Bgx+m[5]*pt.$Bgy+m[13])/m[15]));
      const a=new Uint8Array(4*201);gl.readPixels(x,canvas.height-1-y-100,1,201,gl.RGBA,gl.UNSIGNED_BYTE,a);
      return Array.from({length:201},(_,i)=>255-a[4*i]);}
    const values=profile(),peak=Math.max(...values),center=values.indexOf(peak);
    let reversal=0;for(let i=1;i<values.length;i++)reversal=Math.max(reversal,i<=center?values[i-1]-values[i]:values[i]-values[i-1]);
    const stable=JSON.stringify(values)===JSON.stringify(profile());
    g.$BgremoveChild(avatar);
    const thin=s.flash.display.Sprite.axClass.axConstruct([]);g.$BgaddChild(thin);
    thin.$Bgx=450;thin.$Bgy=300;
    thin.$Bggraphics.$BgbeginFill(0);thin.$Bggraphics.$BgdrawRect(-50,-3,100,6);thin.$Bggraphics.$BgendFill();
    thin.$Bgfilters=s.createArray([new s.flash.filters.DropShadowFilter(0,0,0,1,100,100,1,1,false,false,true)]);
    const broad=profile(),broadPeak=Math.max(...broad),broadCenter=broad.indexOf(broadPeak);
    let broadReversal=0;for(let i=1;i<broad.length;i++)broadReversal=Math.max(broadReversal,i<=broadCenter?broad[i-1]-broad[i]:broad[i]-broad[i-1]);
    thin.$Bgfilters=s.createArray([new s.flash.filters.DropShadowFilter(0,0,0,1,100,100,1,1,false,false,false)]);
    const sharpPeak=Math.max(...profile());
    g.$BgremoveChild(thin);g.$BgremoveChild(bg);for(const [n,v] of visibility)n.visible=v;
    return {peak,reversal,stable,broadPeak,broadReversal,sharpPeak};
  })()`);
  assert.ok(report.avatarShadow.peak > 20, "avatar shadow is visible");
  assert.ok(
    report.avatarShadow.reversal <= 2,
    "blur has one smooth lobe, no repeated shadow stamps",
  );
  assert.equal(
    report.avatarShadow.stable,
    true,
    "unchanged frames do not accumulate shadows",
  );
  assert.ok(report.avatarShadow.broadPeak > 5, "broad shadow remains visible");
  assert.ok(
    report.avatarShadow.broadReversal <= 2,
    "broad drop shadow has no separated copies",
  );
  assert.ok(
    report.avatarShadow.sharpPeak >= 250,
    "shadow downsampling preserves the sharp original",
  );
  report.pixels = await evaluate(`(()=>{
    const p=pixiLiveControls.player,g=p.root._children.find(n=>n.name==='scene').adapter,s=g.sec;
    for(const c of g.adaptee._children)c.visible=false;
    const parent=s.flash.display.Sprite.axClass.axConstruct([]),box=s.flash.display.Sprite.axClass.axConstruct([]);
    g.$BgaddChild(parent);parent.$BgaddChild(box);
    parent.$Bgx=100;parent.$Bgy=100;parent.$BgscaleX=1.5;
    box.$Bggraphics.$BgbeginFill(0xff0000);box.$Bggraphics.$BgdrawRect(0,0,60,40);box.$Bggraphics.$BgendFill();
    const canvas=p._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]'),gl=canvas.getContext('webgl2');
    function readFrame(){const a=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,a);return a;}
    function pixel(x,y,frame){const pt=g.$BglocalToGlobal(new s.flash.geom.Point(x,y));const m=p._view.viewMatrix3D._rawData;
      const px=Math.floor(canvas.width*.5*(1+(m[0]*pt.$Bgx+m[4]*pt.$Bgy+m[12])/m[15]));
      const py=Math.floor(canvas.height*.5*(1-(m[1]*pt.$Bgx+m[5]*pt.$Bgy+m[13])/m[15]));
      if(frame){const i=((canvas.height-1-py)*canvas.width+px)*4;return frame.subarray(i,i+4);}
      const a=new Uint8Array(4);gl.readPixels(px,canvas.height-1-py,1,1,gl.RGBA,gl.UNSIGNED_BYTE,a);return [...a];}
    function sample(){p._renderer.render();return [pixel(130,120),pixel(240,120)];}
    const red=sample();const builds=pixiLive.stats.geometryBuilds;
    parent.$Bgx=210;const moved=sample();const transformReused=pixiLive.stats.geometryBuilds===builds;
    box.$Bggraphics.$Bgclear();box.$Bggraphics.$BgbeginFill(0x00ff00);box.$Bggraphics.$BgdrawRect(0,0,60,40);box.$Bggraphics.$BgendFill();
    const green=sample();box.$Bgvisible=false;const hidden=sample();box.$Bgvisible=true;
    parent.$BgscrollRect=new s.flash.geom.Rectangle(0,0,10,40);const clipped=sample();parent.$BgscrollRect=null;
    const mask=s.flash.display.Sprite.axClass.axConstruct([]);g.$BgaddChild(mask);mask.$Bgx=210;mask.$Bgy=100;
    mask.$Bggraphics.$BgbeginFill(0xffffff);mask.$Bggraphics.$BgdrawRect(0,0,10,40);mask.$Bggraphics.$BgendFill();
    box.$Bgmask=mask;const masked=sample();box.$Bgmask=null;const unmasked=sample();
    parent.$BgremoveChild(box);const removed=sample();parent.$BgaddChild(box);const readded=sample();
    mask.$Bgvisible=false;
    function effect(){p._renderer.render();return {inside:pixel(240,120),left:pixel(208,120),right:pixel(310,120),edge:pixel(211,120)};}
    const glow=new s.flash.filters.GlowFilter(0xff0000,1,6,6,0.5,1,false,false);
    box.$Bgfilters=s.createArray([glow]);const glowPixels=effect();
    glow.$Bgstrength=16;box.$Bgfilters=s.createArray([glow]);const strongerGlow=effect();
    glow.$Bgquality=3;box.$Bgfilters=s.createArray([glow]);const qualityGlow=effect();
    glow.$Bgquality=1;glow.$Bgknockout=true;box.$Bgfilters=s.createArray([glow]);const knockoutGlow=effect();
    glow.$Bgknockout=false;glow.$Bginner=true;box.$Bgfilters=s.createArray([glow]);const innerGlow=effect();
    box.$Bgfilters=s.createArray([new s.flash.filters.DropShadowFilter(12,0,0xff0000,1,0,0,1,1,false,false,true)]);
    const shadowPixels=effect();
    const matrix=new s.flash.filters.ColorMatrixFilter(s.createArray([
      0,1,0,0,0, 0,0,0,0,0, 0,0,0,0,128, 0,0,0,1,0]));
    box.$Bgfilters=s.createArray([matrix]);const matrixPixels=effect();
    matrix.$Bgmatrix=s.createArray([0,0,0,0,64, 0,1,0,0,0, 0,0,0,0,0, 0,0,0,1,0]);
    box.$Bgfilters=s.createArray([matrix]);const changedMatrix=effect();
    box.$Bgfilters=s.createArray([new s.flash.filters.BevelFilter(4,0,0xffffff,1,0,1,4,4,1,1,'inner',false)]);
    const bevelPixels=effect();
    box.$Bgfilters=s.createArray([new s.flash.filters.BlurFilter(8,8,1)]);const blurPixels=effect();
    box.$Bgfilters=s.createArray([]);const clearedGlow=effect();
    const backdrop=s.flash.display.Sprite.axClass.axConstruct([]);g.$BgaddChildAt(backdrop,0);
    backdrop.$Bggraphics.$BgbeginFill(0x800000);backdrop.$Bggraphics.$BgdrawRect(210,100,90,40);backdrop.$Bggraphics.$BgendFill();
    box.$Bggraphics.$Bgclear();box.$Bggraphics.$BgbeginFill(0xffffff);box.$Bggraphics.$BgdrawRect(0,0,60,40);box.$Bggraphics.$BgendFill();
    box.$BgblendMode='overlay';const overlayPixels=effect();box.$BgblendMode='normal';
    box.$Bggraphics.$Bgclear();box.$Bggraphics.$BgbeginFill(0x80ffff,.5);box.$Bggraphics.$BgdrawRect(0,0,60,40);box.$Bggraphics.$BgendFill();
    parent.$BgblendMode='multiply';const directBlendPixels=effect(),directGroups=pixiLive.stats.directBlendGroups;
    const overlap=s.flash.display.Sprite.axClass.axConstruct([]);overlap.$Bggraphics.$BgcopyFrom(box.$Bggraphics);parent.$BgaddChild(overlap);
    const isolatedBlendPixels=effect(),isolatedGroups=pixiLive.stats.isolatedBlendGroups;
    parent.$BgremoveChild(overlap);parent.$BgblendMode='normal';g.$BgremoveChild(backdrop);
    box.$Bggraphics.$Bgclear();box.$Bggraphics.$BgbeginFill(0x00ff00);box.$Bggraphics.$BgdrawRect(0,0,60,40);box.$Bggraphics.$BgendFill();p._renderer.render();
    box.$Bgtransform.$BgcolorTransform=new s.flash.geom.ColorTransform(1,1,1,1,128,0,0,0);
    const customColor=effect();
    box.$Bgtransform.$BgcolorTransform=new s.flash.geom.ColorTransform(1,1,1,1,64,0,0,0);
    const changedCustomColor=effect();
    box.$Bgtransform.$BgcolorTransform=new s.flash.geom.ColorTransform();p._renderer.render();
    const sharedBefore={...pixiLive.stats},copies=[];
    for(let i=0;i<8;i++){
      const copy=s.flash.display.Sprite.axClass.axConstruct([]);
      copy.$Bggraphics.$BgcopyFrom(box.$Bggraphics);
      copy.$Bgx=i===0?400:50*i;copy.$Bgy=i===0?100:230;
      g.$BgaddChild(copy);copies.push(copy);
    }
    p._renderer.render();
    const shared={buildsBefore:sharedBefore.geometryBuilds,buildsAfter:pixiLive.stats.geometryBuilds,
      shares:pixiLive.stats.geometryShares-sharedBefore.geometryShares,first:pixel(420,120)};
    copies[0].$Bgx=450;copies[0].$BgscaleX=1.5;
    p._renderer.render();shared.moved= pixel(470,120);shared.old= pixel(420,120);
    copies[0].$Bgrotation=10;p._renderer.render();
    shared.transformBuilds=pixiLive.stats.geometryBuilds;
    copies[0].$Bgrotation=0;
    copies[0].$Bggraphics.$Bgclear();copies[0].$Bggraphics.$BgbeginFill(0xff0000);
    copies[0].$Bggraphics.$BgdrawRect(0,0,60,40);copies[0].$Bggraphics.$BgendFill();
    p._renderer.render();shared.edited=pixel(470,120);shared.original=pixel(240,120);
    for(let i=0;i<7;i++)g.$BgremoveChild(copies[i]);
    for(let i=0;i<4;i++)p._renderer.render();shared.survivor=pixel(370,250);
    g.$BgremoveChild(copies[7]);
    for(let i=0;i<4;i++)p._renderer.render();
    window.outlinePixel=pixel;window.readOutlineFrame=readFrame;
    // Exercise CPU-backed bitmap updates while native needUpload stays true.
    parent.$BgremoveChild(box);
    const data=new s.flash.display.BitmapData(60,40,true,0xff0000ff);
    const bitmap=s.flash.display.Bitmap.axClass.axConstruct([data]);parent.$BgaddChild(bitmap);
    const bitmapBlue=sample();
    data.adaptee.fillRect(data.adaptee.rect,0xff00ff00,true);const bitmapGreen=sample();
    data.adaptee.fillRect(data.adaptee.rect,0xffff0000,true);const bitmapRed=sample();

    data.adaptee._imageDataDirty=true;const noReadback=data.adaptee.syncData;data.adaptee.syncData=()=>{throw Error('GPU pixel readback')};
    const gpuBitmap=sample(),gpuReported=pixiLive.stats.unsupported['gpu-bitmap'];
    data.adaptee.syncData=noReadback;data.adaptee._imageDataDirty=false;
    window.testDisplayObjects={g,parent,box,mask};
    return {customColor,changedCustomColor,directBlendPixels,directGroups,isolatedBlendPixels,isolatedGroups,overlayPixels,shared,red,moved,transformReused,green,hidden,clipped,masked,unmasked,removed,readded,glowPixels,strongerGlow,qualityGlow,knockoutGlow,innerGlow,shadowPixels,matrixPixels,changedMatrix,bevelPixels,blurPixels,clearedGlow,bitmapBlue,bitmapGreen,bitmapRed,gpuBitmap,gpuReported,stats:structuredClone(pixiLive.stats)};
  })()`);
  const black = [0, 0, 0, 255],
    red = [255, 0, 0, 255],
    green = [0, 255, 0, 255];
  assert.deepEqual(
    report.pixels.overlayPixels.inside,
    red,
    "overlay uses the backdrop instead of normal blending",
  );
  assert.ok(Math.abs(report.pixels.directBlendPixels.inside[0] - 96) <= 1);
  assert.deepEqual(
    report.pixels.directBlendPixels.inside.slice(1),
    [0, 0, 255],
  );
  assert.ok(
    report.pixels.directGroups > 0,
    "single-draw multiply skips the offscreen group",
  );
  assert.ok(Math.abs(report.pixels.isolatedBlendPixels.inside[0] - 80) <= 1);
  assert.ok(
    report.pixels.isolatedGroups > 0,
    "overlapping multiply children remain isolated",
  );
  assert.deepEqual(report.pixels.customColor.inside, [128, 255, 0, 255]);
  assert.deepEqual(report.pixels.changedCustomColor.inside, [64, 255, 0, 255]);
  assert.equal(
    report.pixels.shared.buildsAfter,
    report.pixels.shared.buildsBefore,
    "copies share existing geometry",
  );
  assert.equal(
    report.pixels.shared.transformBuilds,
    report.pixels.shared.buildsBefore,
    "movement, scale and rotation do not rebuild geometry",
  );
  assert.ok(report.pixels.shared.shares >= 8);
  assert.deepEqual(report.pixels.shared.first, green);
  assert.deepEqual(report.pixels.shared.moved, green);
  assert.deepEqual(report.pixels.shared.old, black);
  assert.deepEqual(report.pixels.shared.edited, red);
  assert.deepEqual(report.pixels.shared.original, green);
  assert.deepEqual(report.pixels.shared.survivor, green);
  assert.deepEqual(report.pixels.red, [red, black]);
  assert.deepEqual(report.pixels.moved, [black, red]);
  assert.equal(report.pixels.transformReused, true);
  assert.deepEqual(report.pixels.green, [black, green]);
  for (const name of ["hidden", "clipped", "masked", "removed"])
    assert.deepEqual(report.pixels[name], [black, black], name);
  for (const name of ["unmasked", "readded"])
    assert.deepEqual(report.pixels[name], [black, green], name);
  assert.deepEqual(report.pixels.bitmapBlue, [black, [0, 0, 255, 255]]);
  assert.deepEqual(report.pixels.bitmapGreen, [black, green]);
  assert.deepEqual(report.pixels.bitmapRed, [black, red]);
  assert.deepEqual(report.pixels.gpuBitmap, [black, black]);
  assert.equal(report.pixels.gpuReported, 1);
  assert.deepEqual(report.pixels.glowPixels.inside, green);
  assert.ok(
    report.pixels.glowPixels.left[0] > 0,
    "glow extends outside the shape",
  );
  assert.ok(
    report.pixels.strongerGlow.left[0] > report.pixels.glowPixels.left[0],
    "strength",
  );
  assert.deepEqual(report.pixels.qualityGlow.inside, green);
  assert.deepEqual(report.pixels.qualityGlow.edge, green);
  assert.deepEqual(report.pixels.knockoutGlow.inside, black);
  assert.deepEqual(report.pixels.innerGlow.left, black);
  assert.deepEqual(report.pixels.innerGlow.inside, green);
  assert.ok(report.pixels.innerGlow.edge[0] > 0, "inner edge");
  assert.deepEqual(report.pixels.shadowPixels.right, red);
  assert.deepEqual(report.pixels.shadowPixels.edge, black);
  assert.deepEqual(report.pixels.matrixPixels.inside, [255, 0, 128, 255]);
  assert.deepEqual(report.pixels.changedMatrix.inside, [64, 255, 0, 255]);
  assert.deepEqual(report.pixels.bevelPixels.inside, green);
  assert.notDeepEqual(
    report.pixels.bevelPixels.edge,
    green,
    "bevel changes the edge",
  );
  assert.ok(report.pixels.blurPixels.left[1] > 0, "blur extends the shape");
  assert.deepEqual(report.pixels.clearedGlow.left, black);
  assert.deepEqual(report.pixels.clearedGlow.inside, green);
  report.textOutline = await evaluate(`(()=>{
    const p=pixiLiveControls.player,{g,parent}=testDisplayObjects,s=g.sec;
    while(parent.$BgnumChildren)parent.$BgremoveChildAt(0);
    parent.$BgscaleX=1;
    const text=s.flash.text.TextField.axClass.axConstruct([]);
    text.$BgdefaultTextFormat=new s.flash.text.TextFormat('Mini 7_10pt_st',16,0xffffff);
    text.$BgembedFonts=true;text.$Bgwidth=250;text.$Bgheight=40;text.$Bgtext='OUTLINE';parent.$BgaddChild(text);
    function count(){p._renderer.render();const frame=readOutlineFrame();let red=0,white=0,fringe=0;
      for(let y=94;y<145;y++)for(let x=200;x<450;x++){const v=outlinePixel(x,y,frame);if(v[0]>40&&v[1]<10&&v[2]<10)red++;if(v[0]>240&&v[1]>240&&v[2]>240)white++;if(v[1]>10&&v[1]<240)fringe++;}
      return {red,white,fringe};}
    const plain=count();
    // Shape.getShape reuses objects without clearing originalFillStyle. Text
    // paints through its current material; the old graphic's hint must not win.
    text.adaptee.getEntity()._acceptTraverser({applyTraversable(shape){
      shape.originalFillStyle={data_type:'[graphicsdata SolidFillStyle]',color:0x010101,alpha:1};
    }});
    const pooledFill=count();
    parent.$Bgfilters=s.createArray([new s.flash.filters.GlowFilter(0xff0000,1,3,3,64,1)]);
    const outlined=count();text.$Bgtext='CHANGED';const changed=count();
    parent.$Bgfilters=s.createArray([new s.flash.filters.DropShadowFilter(0,45,0xff0000,1,3,3,5,1,false,false,false)]);
    const chatBorder=count();
    parent.$Bgfilters=s.createArray([new s.flash.filters.GlowFilter(0xff0000,1,3,3,64,1)]);
    window.countOutline=count;return {plain,pooledFill,outlined,changed,chatBorder};
  })()`);
  assert.equal(report.textOutline.plain.red, 0);
  assert.ok(report.textOutline.plain.white > 10);
  assert.deepEqual(
    report.textOutline.pooledFill,
    report.textOutline.plain,
    "recycled fill metadata cannot recolor live text",
  );
  assert.ok(report.textOutline.outlined.red > 10);
  assert.ok(report.textOutline.outlined.white > 10);
  assert.ok(
    report.textOutline.plain.fringe > 0,
    "unfiltered glyphs have antialiased edges",
  );
  assert.ok(
    report.textOutline.outlined.fringe >= report.textOutline.plain.fringe * 0.9,
    "filter input preserves glyph antialiasing",
  );
  assert.ok(report.textOutline.changed.red > 10);
  assert.ok(report.textOutline.changed.white > 10);
  assert.deepEqual(
    report.textOutline.chatBorder,
    report.textOutline.changed,
    "strong zero-offset chat shadows use the same crisp border as name glows",
  );
  report.effectCache = await evaluate(`(()=>{
    const p=pixiLiveControls.player,{g,parent}=testDisplayObjects,s=g.sec;
    const marker=s.flash.display.Sprite.axClass.axConstruct([]);g.$BgaddChild(marker);
    marker.$Bggraphics.$BgbeginFill(0xffffff);marker.$Bggraphics.$BgdrawRect(0,0,4,4);marker.$Bggraphics.$BgendFill();
    const expected=countOutline();
    // Retained effects warm up on actual draws. Idle direct-object frames may
    // reuse the whole canvas, so move the unrelated marker to force a draw.
    marker.$Bgx=-1;countOutline();marker.$Bgx=0;countOutline();
    const before={...pixiLive.stats};let stable=true,skipped=0;
    for(let i=0;i<6;i++){marker.$Bgx=i+1;stable &&= JSON.stringify(countOutline())===JSON.stringify(expected);skipped+=pixiLive.stats.skippedSubtrees;}
    const hits=pixiLive.stats.effectCacheHits-before.effectCacheHits,builds=pixiLive.stats.effectCacheBuilds-before.effectCacheBuilds;
    parent.$Bgalpha=.5;const faded=countOutline();parent.$Bgalpha=1;const restored=countOutline();
    // A fractional ancestor move can change rasterization without changing the
    // rounded filter bounds. It must still invalidate the descendant effect.
    const holder=s.flash.display.Sprite.axClass.axConstruct([]);g.$BgaddChild(holder);holder.$BgaddChild(parent);
    countOutline();const transformBefore=pixiLive.stats.effectPasses;
    holder.$Bgx=.1;countOutline();const transformBuilds=pixiLive.stats.effectPasses-transformBefore;
    g.$BgaddChild(parent);g.$BgremoveChild(holder);g.$BgremoveChild(marker);countOutline();
    return {stable,skipped,hits,builds,faded,restored,expected,transformBuilds,pixels:pixiLive.stats.effectCachePixels};
  })()`);
  assert.equal(report.effectCache.stable, true);
  assert.ok(
    (directObjects ? report.effectCache.skipped : report.effectCache.hits) >= 6,
    "unrelated changes reuse filter results",
  );
  assert.equal(
    report.effectCache.builds,
    0,
    "unrelated changes do not rerun effects",
  );
  assert.equal(
    report.effectCache.faded.white,
    0,
    "ancestor opacity invalidates cached text",
  );
  assert.deepEqual(report.effectCache.restored, report.effectCache.expected);
  assert.ok(
    report.effectCache.transformBuilds > 0,
    "fractional ancestor movement invalidates effects",
  );
  assert.ok(
    report.effectCache.pixels <= 16 * 1024 * 1024,
    "retained effect memory is bounded",
  );
  if (directObjects) {
    report.scenery = await evaluate(`(()=>{
      const p=pixiLiveControls.player,{g}=testDisplayObjects,s=g.sec;
      const scenery=s.flash.display.Sprite.axClass.axConstruct([]);g.$BgaddChild(scenery);
      scenery.$Bgx=500;scenery.$Bgy=180;
      let first;
      for(let i=0;i<80;i++) {
        const child=s.flash.display.Sprite.axClass.axConstruct([]);scenery.$BgaddChild(child);
        child.$Bgx=(i%10)*12;child.$Bgy=Math.floor(i/10)*12;
        child.$Bggraphics.$BgbeginFill(0xff0000);child.$Bggraphics.$BgdrawRect(0,0,10,10);child.$Bggraphics.$BgendFill();
        first ||= child;
      }
      const native=pixiLive.getDisplayObject(scenery),content=native.children[0];
      const sample=()=>{p._renderer.render();return Array.from(outlinePixel(505,185,readOutlineFrame()));};
      const before=sample();
      // Flash may invalidate unchanged timeline objects every tick. These must
      // not restart cache warmup or discard an already captured picture.
      function invalidateUnchanged(){scenery.adaptee.invalidate();scenery.adaptee._invalidateHierarchicalProperty(255);}
      for(let i=0;i<26;i++){invalidateUnchanged();p._renderer.render();}
      const cached=content.isCachedAsTexture,after=sample(),builds=pixiLive.stats.sceneryBuilds;
      const draws=pixiLive.stats.drawnFrames;
      for(let i=0;i<30;i++){invalidateUnchanged();p._renderer.render();}
      const invalidationReused=content.isCachedAsTexture&&pixiLive.stats.sceneryBuilds===builds&&pixiLive.stats.drawnFrames===draws;
      // An unrelated moving object forces draws while this texture stays retained.
      const marker=s.flash.display.Sprite.axClass.axConstruct([]);g.$BgaddChild(marker);
      for(let i=0;i<5;i++){marker.$Bgx=i;sample();}
      const reused=pixiLive.stats.sceneryBuilds===builds;
      first.$Bggraphics.$Bgclear();first.$Bggraphics.$BgbeginFill(0x00ff00);
      first.$Bggraphics.$BgdrawRect(0,0,10,10);first.$Bggraphics.$BgendFill();
      const edited=sample(),invalidated=!content.isCachedAsTexture;
      for(let i=0;i<26;i++)p._renderer.render();
      const recached=content.isCachedAsTexture;
      g.$Bgvisible=false;sample();const hiddenReleased=!content.isCachedAsTexture;
      g.$Bgvisible=true;for(let i=0;i<26;i++)p._renderer.render();
      scenery.$BgscaleX=2;sample();const resized=!content.isCachedAsTexture;
      for(let i=0;i<26;i++)p._renderer.render();
      const oldScale=g.$BgscaleX;g.$BgscaleX=oldScale*1.1;sample();
      const ancestorResized=!content.isCachedAsTexture;g.$BgscaleX=oldScale;
      g.$BgremoveChild(scenery);g.$BgremoveChild(marker);
      for(let i=0;i<5;i++)p._renderer.render();
      return {before,after,cached,reused,invalidationReused,edited,invalidated,recached,hiddenReleased,resized,ancestorResized,retired:content.destroyed,pixels:pixiLive.stats.sceneryPixels};
    })()`);
    assert.deepEqual(report.scenery.before,[255,0,0,255]);
    assert.deepEqual(report.scenery.after,report.scenery.before);
    assert.deepEqual(report.scenery.edited,[0,255,0,255]);
    for(const name of ['cached','reused','invalidationReused','invalidated','recached','hiddenReleased','resized','ancestorResized','retired'])
      assert.equal(report.scenery[name],true,name);
    assert.ok(report.scenery.pixels<=8*1024*1024);
  }
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1800,
    height: 1000,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await new Promise((r) => setTimeout(r, 500));
  report.resize = await evaluate(
    `(()=>{const p=pixiLiveControls.player;p._renderer.render();const canvas=p._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');return {outline:countOutline(),size:[canvas.width,canvas.height],native:[p._view.stage.context._gl.canvas.width,p._view.stage.context._gl.canvas.height],stats:structuredClone(pixiLive.stats)}})()`,
  );
  assert.deepEqual(report.resize.size, report.resize.native);
  assert.equal(report.resize.stats.lastError, null);
  assert.ok(report.resize.outline.red > 10);
  assert.ok(report.resize.outline.white > 10);
  report.stop =
    await evaluate(`(()=>{const p=pixiLiveControls.player;pixiLiveControls.stop();const restored=p._renderer.render!==originalRootRender;p._renderer.render=originalRootRender;
    const {g,parent,mask}=testDisplayObjects;g.$BgremoveChild(parent);g.$BgremoveChild(mask);for(const c of g.adaptee._children)c.visible=true;
    p._renderer.render();return {canvasRemoved:!p._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]'),restored,active:pixiLive.stats.active,cachePixels:pixiLive.stats.effectCachePixels,hooksRestored:[p.root._invalidateHierarchicalProperty,p.root._setParent,p.root.addChildAt,p.root.invalidate,p.root._invalidateStyle,p.root._invalidateMaterial,p.root.invalidateElements].every((f,i)=>f===originalObjectHooks[i]),ownershipReleased:!pixiLive.getDisplayObject(p.root)};})()`);
  assert.equal(report.stop.canvasRemoved, true);
  assert.equal(report.stop.hooksRestored, true);
  assert.equal(report.stop.ownershipReleased, true);
  assert.equal(report.stop.active, false);
  assert.equal(report.stop.restored, true);
  assert.equal(
    report.stop.cachePixels,
    0,
    "stop releases retained filter textures",
  );
  report.restart = await evaluate(
    `(async()=>{await pixiLiveControls.enable();const p=pixiLiveControls.player;for(let i=0;i<3;i++)p._renderer.render();return structuredClone(pixiLive.stats)})()`,
  );
  assert.equal(report.restart.active, true);
  assert.equal(report.restart.lastError, null);
  // Exercise a real map's vector tree without logging into a server. The
  // fixture additionally creates a GPU-only BitmapData; report that gap, then
  // expose its original vector source for an independent rendering smoke test.
  await send("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  });
  report.battleon = await evaluate(`(async()=>{
    const p=pixiLiveControls.player;p.isPaused=false;
    const fixture=await pixiLiveControls.loadFixture();p.isPaused=true;
    for(let i=0;i<4;i++)p._renderer.render();const gpuReported=pixiLive.stats.unsupported['gpu-bitmap'];
    const map=fixture.map.adaptee;map._children[0].visible=true;map._children[1].visible=false;
    for(let i=0;i<30;i++)p._renderer.render();
    return {gpuReported,stats:structuredClone(pixiLive.stats)};
  })()`);
  assert.ok(report.battleon.gpuReported > 0);
  assert.equal(report.battleon.stats.active, true);
  assert.equal(report.battleon.stats.lastError, null);
  assert.ok(report.battleon.stats.meshes > 1000);
  if (directObjects) {
    report.sceneryComparison = await evaluate(`(async()=>{
      const p=pixiLiveControls.player,g=p.root._children.find(n=>n.name==='scene').adapter;
      const marker=g.sec.flash.display.Sprite.axClass.axConstruct([]);g.$BgaddChild(marker);
      let lastDraws=0;
      function pixels(){
        // Read in the same task as a real draw: WebGL does not preserve the
        // drawing buffer after browser presentation. Leave cached map branches alone.
        const canvas=p._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');
        const gl=canvas.getContext('webgl2')||canvas.getContext('webgl');
        const hooks={};lastDraws=0;
        for(const name of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']) {
          hooks[name]=gl[name];gl[name]=function(...args){lastDraws++;return hooks[name].apply(this,args)};
        }
        try { marker.$Bgx++;p._renderer.render(); }
        finally { for(const [name,fn] of Object.entries(hooks))gl[name]=fn; }
        const data=new Uint8Array(canvas.width*canvas.height*4);
        gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);return data;
      }
      const cached=pixels(),groups=pixiLive.stats.sceneryCaches,meshes=pixiLive.stats.sceneryMeshesCached;
      pixiLiveControls.stop();await pixiLiveControls.enable({cacheScenery:false});
      for(let i=0;i<3;i++)p._renderer.render();
      const reference=pixels();let difference=0,changed=0;
      for(let i=0;i<cached.length;i+=4){let delta=0;for(let j=0;j<3;j++){const d=Math.abs(cached[i+j]-reference[i+j]);difference+=d;delta=Math.max(delta,d);}if(delta>16)changed++;}
      const batchedDraws=lastDraws,vectorMeshes=pixiLive.stats.vectorBatchedMeshes;
      pixiLiveControls.stop();await pixiLiveControls.enable({cacheScenery:false,vectorBatching:false});
      for(let i=0;i<3;i++)p._renderer.render();
      const unbatched=pixels();let vectorError=0,vectorChanged=0;
      for(let i=0;i<reference.length;i+=4){let delta=0;for(let j=0;j<3;j++){const d=Math.abs(reference[i+j]-unbatched[i+j]);vectorError+=d;delta=Math.max(delta,d);}if(delta>16)vectorChanged++;}
      const batching={meshes:vectorMeshes,batchedDraws,unbatchedDraws:lastDraws,meanError:vectorError/(reference.length/4*3),changedPercent:vectorChanged/(reference.length/4)*100};
      g.$BgremoveChild(marker);
      return {groups,meshes,batching,meanError:difference/(cached.length/4*3),changedPercent:changed/(cached.length/4)*100};
    })()`);
    assert.ok(report.sceneryComparison.groups>0,'real map has cached scenery');
    assert.ok(report.sceneryComparison.meanError<2,'cache preserves map colors: '+JSON.stringify(report.sceneryComparison));
    assert.ok(report.sceneryComparison.changedPercent<5,'cache preserves map geometry');
    const batching=report.sceneryComparison.batching;
    assert.ok(batching.meshes>1000,'color-transformed vectors join batches');
    // This ratio tests the old all-mesh workload. Native Graphics uses Pixi's
    // default batcher and introduces different batch boundaries; record its
    // draw counts without promising the same speedup. Pixel checks still apply.
    if (!nativeGraphics)
      assert.ok(batching.batchedDraws<batching.unbatchedDraws/2,'vector batching reduces actual WebGL draws');
    assert.ok(batching.meanError<0.2&&batching.changedPercent<0.5,'batched vectors preserve pixels: '+JSON.stringify(batching));
  }
  // Backdrop reads should resolve only their rectangle, while the final
  // presentation and chained offscreen filters retain their complete output.
  report.blendResolve = await evaluate(`(async()=>{
    const p=pixiLiveControls.player,g=p.root._children.find(n=>n.name==='scene').adapter;
    const marker=g.sec.flash.display.Sprite.axClass.axConstruct([]);g.$BgaddChild(marker);
    const s=g.sec,edges=[];
    // Nested MSAA filter targets and clipped backdrop reads on both canvas edges.
    for(const x of [-25,940]){
      const outer=s.flash.display.Sprite.axClass.axConstruct([]),inner=s.flash.display.Sprite.axClass.axConstruct([]);
      g.$BgaddChild(outer);outer.$Bgx=x;outer.$Bgy=80;outer.$BgaddChild(inner);
      outer.$Bggraphics.$BgbeginFill(0x668899);outer.$Bggraphics.$BgdrawRect(0,0,60,60);outer.$Bggraphics.$BgendFill();
      outer.$Bgfilters=s.createArray([new s.flash.filters.BlurFilter(4,4,1)]);
      inner.$Bggraphics.$BgbeginFill(0x80ffff,.7);inner.$Bggraphics.$BgdrawRect(-10,5,45,35);inner.$Bggraphics.$BgendFill();
      inner.$BgblendMode='overlay';edges.push(outer);
    }
    async function sample(boundedBlends){
      pixiLiveControls.stop();await pixiLiveControls.enable({boundedBlends,cacheScenery:false});
      p._renderer.render();
      const canvas=p._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');
      const gl=canvas.getContext('webgl2')||canvas.getContext('webgl');
      const original=gl.blitFramebuffer;let blits=0,texels=0;
      gl.blitFramebuffer=function(...a){blits++;texels+=Math.abs((a[2]-a[0])*(a[3]-a[1]));return original.apply(this,a)};
      try {marker.$Bgx++;p._renderer.render();} finally {gl.blitFramebuffer=original;}
      const pixels=new Uint8Array(canvas.width*canvas.height*4);
      gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      return {pixels,blits,texels};
    }
    const before=await sample(false),after=await sample(true);
    let difference=0,maxDifference=0;
    for(let i=0;i<before.pixels.length;i++){
      const delta=Math.abs(before.pixels[i]-after.pixels[i]);difference+=delta;maxDifference=Math.max(maxDifference,delta);
    }
    g.$BgremoveChild(marker);for(const edge of edges)g.$BgremoveChild(edge);
    return {before:{blits:before.blits,texels:before.texels},after:{blits:after.blits,texels:after.texels},meanError:difference/before.pixels.length,maxDifference};
  })()`);
  assert.ok(report.blendResolve.after.texels < report.blendResolve.before.texels / 4, 'backdrop resolve area reduced');
  assert.ok(report.blendResolve.meanError < 0.01 && report.blendResolve.maxDifference <= 4, 'bounded resolves preserve pixels: '+JSON.stringify(report.blendResolve));
  report.filterUpdates = await evaluate(`(async()=>{
    const {checkFilterUpdates}=await import('./check-filter-browser.js?test='+Date.now());
    return checkFilterUpdates();
  })()`);
  assert.equal(report.filterUpdates.results.length,20);
  assert.equal(report.filterUpdates.retainedPixels,0);
  assert.equal(report.filterUpdates.glError,0);
  report.sparseUploads = await evaluate(`(async()=>{
    const p=pixiLiveControls.player,g=p.root._children.find(n=>n.name==='scene').adapter,s=g.sec;
    const parent=s.flash.display.Sprite.axClass.axConstruct([]);parent.adaptee.name='sparse-upload-regression';g.$BgaddChild(parent);
    function child(){const c=s.flash.display.Sprite.axClass.axConstruct([]);parent.$BgaddChild(c);return c;}
    function marker(){const c=child();c.$Bggraphics.$BgbeginFill(0xff7700);c.$Bggraphics.$BgdrawRect(0,0,4,4);c.$Bggraphics.$BgendFill();return c;}
    const first=marker();
    for(let i=0;i<20;i++){
      const c=child();c.$Bggraphics.$BgbeginFill(0x55ccee);
      for(let q=0;q<150;q++)c.$Bggraphics.$BgdrawRect(q%15*0.3,i*3+10+Math.floor(q/15)*0.3,0.2,0.2);
      c.$Bggraphics.$BgendFill();
    }
    const last=marker();last.$Bgy=80;
    async function sample(sparseUploads,skipUnchanged=true,redundant=false){
      first.$Bgx=last.$Bgx=0;pixiLiveControls.stop();await pixiLiveControls.enable({sparseUploads,skipUnchanged,cacheScenery:false});p._renderer.render();
      const pending=pixiLive.profile(3);
      for(let i=0;i<3;i++){
        first.$Bgx=last.$Bgx=10+i;
        if(redundant){
          function mark(o){if(o.renderPipeId==='mesh')o.onViewUpdate();for(const c of o.children||[])mark(c);}
          mark(pixiLive.getDisplayObject(parent.adaptee));
        }
        p._renderer.render();
      }
      const result=await pending,canvas=p._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');
      const gl=canvas.getContext('webgl2')||canvas.getContext('webgl'),pixels=new Uint8Array(canvas.width*canvas.height*4);
      gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      return {result,pixels,glError:gl.getError()};
    }
    const before=await sample(false),after=await sample(true);
    let pixelDelta=0;for(let i=0;i<before.pixels.length;i++)pixelDelta=Math.max(pixelDelta,Math.abs(before.pixels[i]-after.pixels[i]));
    const compact=x=>({median:x.result.median,groups:x.result.groups.filter(g=>g.path.includes('sparse-upload-regression')),glError:x.glError});
    const dirtyBefore=await sample(true,false,true),dirtyAfter=await sample(true,true,true);
    let dirtyDelta=0;for(let i=0;i<dirtyBefore.pixels.length;i++)dirtyDelta=Math.max(dirtyDelta,Math.abs(dirtyBefore.pixels[i]-dirtyAfter.pixels[i]));
    const redundant={before:compact(dirtyBefore),after:compact(dirtyAfter),pixelDelta:dirtyDelta};
    const instanced=!!pixiLive.stats.configuration.instancedTransforms;
    g.$BgremoveChild(parent);pixiLiveControls.stop();await pixiLiveControls.enable();p._renderer.render();
    return {before:compact(before),after:compact(after),pixelDelta,redundant,instanced};
  })()`);
  assert.equal(report.sparseUploads.redundant.pixelDelta,0,'redundant updates preserve pixels');
  assert.equal(report.sparseUploads.redundant.after.glError,0);
  assert.ok(report.sparseUploads.redundant.after.median.uploadBytes<report.sparseUploads.redundant.before.median.uploadBytes/100,'redundant invalidations do not repack static neighbors');
  assert.ok(report.sparseUploads.redundant.after.median.unchangedUpdates>=20,'profile counts skipped updates');
  assert.equal(report.sparseUploads.pixelDelta,0,'sparse uploads preserve all pixels');
  assert.equal(report.sparseUploads.after.glError,0);
  if (report.sparseUploads.instanced) {
    // With instanced transforms a moved mesh rewrites its matrix row, not
    // its vertices: neither sample uploads vertex data for the markers.
    assert.ok(report.sparseUploads.before.median.uploadBytes<=report.sparseUploads.after.median.uploadBytes*4+4096,'instanced transforms leave vertices in place for both samples: '+JSON.stringify([report.sparseUploads.before.median.uploadBytes,report.sparseUploads.after.median.uploadBytes]));
    assert.ok(report.sparseUploads.after.median.matrixUpdates>=2,'moved markers update their matrix rows: '+report.sparseUploads.after.median.matrixUpdates);
  } else
  assert.ok(report.sparseUploads.after.median.uploadBytes<report.sparseUploads.before.median.uploadBytes/100,'distant edits leave untouched middle vertices uploaded');
  assert.ok(report.sparseUploads.after.groups.every(g=>g.rebuilds===0),'sparse edits keep batch layout');
  report.changingTopology = await evaluate(`(async()=>{
    const p=pixiLiveControls.player,g=p.root._children.find(n=>n.name==='scene').adapter,s=g.sec;
    const parent=s.flash.display.Sprite.axClass.axConstruct([]);parent.adaptee.name='morph-batch-regression';g.$BgaddChild(parent);
    for(let i=0;i<20;i++){
      const child=s.flash.display.Sprite.axClass.axConstruct([]);parent.$BgaddChild(child);
      child.$Bggraphics.$BgbeginFill(0x55ccee);
      for(let q=0;q<150;q++)child.$Bggraphics.$BgdrawRect(q%15*0.3,i*3+Math.floor(q/15)*0.3,0.2,0.2);
      child.$Bggraphics.$BgendFill();
    }
    const morph=s.flash.display.Sprite.axClass.axConstruct([]);morph.adaptee.name='changing-shape';parent.$BgaddChild(morph);
    function draw(count){
      const graphics=morph.$Bggraphics;graphics.$Bgclear();graphics.$BgbeginFill(0xff7700);
      for(let i=0;i<count;i++)graphics.$BgdrawRect(70+i*4,5,3,3);
      graphics.$BgendFill();
    }
    async function sample(isolateTopology){
      draw(1);pixiLiveControls.stop();await pixiLiveControls.enable({isolateTopology,cacheScenery:false});p._renderer.render();
      // Learn that this persistent object changes geometry size, then measure
      // subsequent changes. Its many small static neighbors stay in one group.
      draw(2);p._renderer.render();
      const pending=pixiLive.profile(3);
      for(let i=0;i<3;i++){draw(i+3);p._renderer.render();}
      const result=await pending,canvas=p._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');
      const gl=canvas.getContext('webgl2')||canvas.getContext('webgl'),pixels=new Uint8Array(canvas.width*canvas.height*4);
      gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      const isolated=result.groups.some(g=>g.path.endsWith('/changing-shape'));
      return {result,pixels,isolated,glError:gl.getError()};
    }
    const before=await sample(false),after=await sample(true);
    let delta=0,sum=0;for(let i=0;i<before.pixels.length;i++){const d=Math.abs(before.pixels[i]-after.pixels[i]);delta=Math.max(delta,d);sum+=d;}
    const compact=x=>({median:x.result.median,groups:x.result.groups.filter(g=>g.path.includes('morph-batch-regression')),isolated:x.isolated,glError:x.glError});
    g.$BgremoveChild(parent);pixiLiveControls.stop();await pixiLiveControls.enable();p._renderer.render();
    return {before:compact(before),after:compact(after),pixelDelta:delta,meanError:sum/before.pixels.length};
  })()`);
  assert.equal(report.changingTopology.before.isolated,false);
  assert.equal(report.changingTopology.after.isolated,true);
  assert.equal(report.changingTopology.after.glError,0);
  assert.ok(report.changingTopology.after.median.uploadBytes < report.changingTopology.before.median.uploadBytes/10,'changing shape leaves dense neighbors uploaded: '+JSON.stringify(report.changingTopology));
  assert.ok(report.changingTopology.after.groups.every(g=>g.path.endsWith('/changing-shape')||g.rebuilds===0),'only changing shape rebuilds');
  assert.ok(report.changingTopology.meanError<0.01&&report.changingTopology.pixelDelta<=8,'topology isolation preserves pixels');
  report.animatedFilters = await evaluate(`(async()=>{
    const p=pixiLiveControls.player,g=p.root._children.find(n=>n.name==='scene').adapter,s=g.sec;
    const parent=s.flash.display.Sprite.axClass.axConstruct([]);parent.adaptee.name='filter-update-regression';g.$BgaddChild(parent);
    let filtered;
    for(let i=0;i<70;i++){
      const child=s.flash.display.Sprite.axClass.axConstruct([]);parent.$BgaddChild(child);
      child.$Bggraphics.$BgbeginFill(0x55ccee);child.$Bggraphics.$BgdrawRect(i%10*8,Math.floor(i/10)*8,5,5);child.$Bggraphics.$BgendFill();
      if(i===0)filtered=child;
    }
    async function sample(reuseFilters){
      pixiLiveControls.stop();await pixiLiveControls.enable({reuseFilters,cacheScenery:false});
      filtered.$Bgfilters=s.createArray([new s.flash.filters.BlurFilter(2,5,1)]);p._renderer.render();
      const pending=pixiLive.profile(3);
      for(let i=0;i<3;i++){
        filtered.$Bgfilters=s.createArray([new s.flash.filters.BlurFilter(3+i,5,1)]);p._renderer.render();
      }
      const result=await pending;
      const groups=result.groups.filter(g=>g.path.includes('filter-update-regression'));
      return {median:result.median,rebuilds:groups.reduce((n,g)=>n+g.rebuilds,0),groups};
    }
    const before=await sample(false),after=await sample(true);
    g.$BgremoveChild(parent);pixiLiveControls.stop();await pixiLiveControls.enable();p._renderer.render();
    return {before,after};
  })()`);
  assert.ok(report.animatedFilters.before.rebuilds>=3,'reference recreates effect attachments');
  assert.equal(report.animatedFilters.after.rebuilds,0,'uniform changes preserve native branch batches');
  report.profile = await evaluate(`(async()=>{
    const p=pixiLiveControls.player,g=p.root._children.find(n=>n.name==='scene').adapter;
    const marker=g.sec.flash.display.Sprite.axClass.axConstruct([]);g.$BgaddChild(marker);
    marker.$Bggraphics.$BgbeginFill(0xff0000);marker.$Bggraphics.$BgdrawRect(0,0,8,8);marker.$Bggraphics.$BgendFill();
    let animatedChild;
    async function sample(partialUploads,renderGroups=false,topology=false,groupVertexLimit=12000){
      if(animatedChild){marker.$BgremoveChild(animatedChild);animatedChild=null;}
      pixiLiveControls.stop();await pixiLiveControls.enable({partialUploads,cacheScenery:false,renderGroups,groupVertexLimit});
      marker.$Bgx=10;p._renderer.render();
      const canvas=p._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');
      const gl=canvas.getContext('webgl2')||canvas.getContext('webgl'),original=gl.drawElements;
      const pending=pixiLive.profile(3);
      for(let i=0;i<3;i++){
        marker.$Bgx=20+i;
        if(topology){
          if(animatedChild)marker.$BgremoveChild(animatedChild);
          animatedChild=g.sec.flash.display.Sprite.axClass.axConstruct([]);marker.$BgaddChild(animatedChild);
          animatedChild.$Bggraphics.$BgbeginFill(0x00ff00);animatedChild.$Bggraphics.$BgdrawRect(0,0,8+i,8);animatedChild.$Bggraphics.$BgendFill();
        }
        p._renderer.render();
      }
      const pixels=new Uint8Array(canvas.width*canvas.height*4);
      gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      const result=await pending;
      return {result,pixels,restored:gl.drawElements===original,gl,original};
    }
    const after=await sample(true),before=await sample(false);
    let pixelDelta=0;for(let i=0;i<before.pixels.length;i++)pixelDelta=Math.max(pixelDelta,Math.abs(before.pixels[i]-after.pixels[i]));
    const grouped=await sample(true,true,true),ungrouped=await sample(true,false,true);
    let groupError=0,groupChanged=0;
    for(let i=0;i<grouped.pixels.length;i+=4){let delta=0;for(let j=0;j<3;j++){const d=Math.abs(grouped.pixels[i+j]-ungrouped.pixels[i+j]);groupError+=d;delta=Math.max(delta,d);}if(delta>16)groupChanged++;}
    const topology={grouped:grouped.result.median,ungrouped:ungrouped.result.median,groups:grouped.result.groups,meanError:groupError/(grouped.pixels.length/4*3),changedPercent:groupChanged/(grouped.pixels.length/4)*100};
    // Under 64 shapes, but tens of thousands of vertices. Replacing the tiny
    // animated sibling must not resend all three static clusters.
    const clusters=[];
    for(let k=0;k<3;k++){
      const cluster=g.sec.flash.display.Sprite.axClass.axConstruct([]);marker.$BgaddChild(cluster);clusters.push(cluster);
      for(let j=0;j<12;j++){
        const shape=g.sec.flash.display.Sprite.axClass.axConstruct([]);cluster.$BgaddChild(shape);
        shape.$Bggraphics.$BgbeginFill(0x3388cc);
        for(let q=0;q<200;q++)shape.$Bggraphics.$BgdrawRect(q%20*0.2,j*3+Math.floor(q/20)*0.2,0.15,0.15);
        shape.$Bggraphics.$BgendFill();
      }
    }
    const denseAfter=await sample(true,true,true),denseBefore=await sample(true,true,true,0);
    let denseError=0,denseSum=0,denseChanged=0;
    for(let i=0;i<denseAfter.pixels.length;i+=4){let delta=0;for(let j=0;j<3;j++){const d=Math.abs(denseAfter.pixels[i+j]-denseBefore.pixels[i+j]);denseSum+=d;delta=Math.max(delta,d);}denseError=Math.max(denseError,delta);if(delta>16)denseChanged++;}
    const vertexGroups={before:denseBefore.result.median,after:denseAfter.result.median,pixelDelta:denseError,meanError:denseSum/(denseAfter.pixels.length/4*3),changedPercent:denseChanged/(denseAfter.pixels.length/4)*100};
    for(const cluster of clusters)marker.$BgremoveChild(cluster);
    const cancelled=pixiLive.profile(3);pixiLiveControls.stop();const stopped=await cancelled;
    g.$BgremoveChild(marker);await pixiLiveControls.enable();p._renderer.render();
    return {result:after.result,fullUploads:before.result.median.uploadBytes,pixelDelta,topology,vertexGroups,restored:after.restored&&before.restored,cancelled:stopped.reason,cancelRestored:before.gl.drawElements===before.original};
  })()`);
  assert.equal(report.profile.result.reason,'complete');
  assert.equal(report.profile.result.frames.length,3);
  const groupUploads = report.profile.result.groups.reduce((n,g)=>n+g.uploadBytes,0);
  const totalUploads = report.profile.result.frames.reduce((n,f)=>n+f.uploadBytes,0);
  if (report.sparseUploads.instanced) {
    // A moved marker rewrites its matrix row: no vertex traffic at all.
    assert.equal(totalUploads,0,'instanced transforms move the marker without vertex uploads');
    assert.ok(report.profile.result.frames.every(f=>f.matrixUpdates>=1),'each frame updates the marker matrix');
  } else
  assert.ok(groupUploads>0 && groupUploads<=totalUploads,'group uploads count actual GL traffic without duplication: '+JSON.stringify({groupUploads,totalUploads,groups:report.profile.result.groups.map(g=>[g.path,g.uploadBytes,g.rebuilds]).slice(0,6),frames:report.profile.result.frames.map(f=>[f.uploadBytes,f.packedUpdates,f.matrixUpdates])}));
  const groupUpdates = report.profile.result.groups.reduce((n,g)=>n+g.updateMs,0);
  const totalUpdates = report.profile.result.frames.reduce((n,f)=>n+f.batchUpdateMs,0);
  assert.ok(Math.abs(groupUpdates-totalUpdates)<0.01,'exclusive group timings sum to total batch time');
  assert.ok(report.profile.topology.groups.some(g=>g.rebuilds>0&&g.uploadBytes>0),'structural uploads attributed to rebuilt group');
  assert.ok(report.profile.topology.groups.some(g=>g.path.includes('scene')),'profiles identify native object branches');
  assert.ok(report.profile.result.median.draws>100);
  assert.ok(report.profile.result.median.triangles>1000);
  if (!report.sparseUploads.instanced) assert.ok(report.profile.result.median.uploadBytes>0);
  assert.ok(report.profile.result.median.uploadBytes<report.profile.fullUploads/10||(report.sparseUploads.instanced&&report.profile.result.median.uploadBytes===0),'moving one mesh does not re-upload static scenery');
  assert.equal(report.profile.pixelDelta,0,'partial uploads preserve pixels');
  assert.ok(report.profile.topology.grouped.uploadBytes<report.profile.topology.ungrouped.uploadBytes/10,'animated topology rebuilds only its group: '+JSON.stringify(report.profile.topology));
  assert.ok(report.profile.topology.meanError<0.2&&report.profile.topology.changedPercent<0.5,'render groups preserve pixels: '+JSON.stringify(report.profile.topology));
  assert.ok(report.profile.vertexGroups.after.uploadBytes<report.profile.vertexGroups.before.uploadBytes/5,'dense static siblings retain their vertex buffers: '+JSON.stringify(report.profile.vertexGroups));
  assert.ok(report.profile.vertexGroups.meanError<0.2&&report.profile.vertexGroups.changedPercent<0.5,'vertex grouping preserves pixels: '+JSON.stringify(report.profile.vertexGroups));
  assert.equal(report.profile.restored,true);
  assert.equal(report.profile.cancelled,'renderer stopped');
  assert.equal(report.profile.cancelRestored,true);
  assert.deepEqual(errors, []);
  report.failure = await evaluate(`(async()=>{
    const p=pixiLiveControls.player,canvas=p._view.stage.context._gl.canvas;
    const measure=canvas.getBoundingClientRect;
    canvas.getBoundingClientRect=()=>{throw Error('intentional-render-failure')};
    p.isPaused=false;p._renderer.render();canvas.getBoundingClientRect=measure;
    const blocked=p._renderer.render;
    for(let i=0;i<3;i++)p._renderer.render();
    const held={failed:pixiLive.stats.failed,paused:p.isPaused,selected:pixiLive.active,blocked:p._renderer.render===blocked};
    pixiLiveControls.stop();const restored=p._renderer.render===originalRootRender&&!p.isPaused;
    p.isPaused=true;await pixiLiveControls.enable();
    const pixiCanvas=canvas.ownerDocument.querySelector('[data-pixi-display-list]');
    const event=new Event('webglcontextlost',{cancelable:true});pixiCanvas.dispatchEvent(event);
    p._renderer.render();
    const context={prevented:event.defaultPrevented,paused:p.isPaused,selected:pixiLive.active,failed:pixiLive.stats.failed};
    pixiLiveControls.stop();
    let nativeCalls=0;
    p._renderer.render=()=>{nativeCalls++;throw Error('intentional-bridge-failure');};
    await pixiLiveControls.enable({backend:'bridge'});p._renderer.render();p._renderer.render();
    const bridge={failed:pixiLive.stats.failed,selected:pixiLive.active,paused:p.isPaused,nativeCalls};
    pixiLiveControls.stop();p._renderer.render=originalRootRender;
    const doc=canvas.ownerDocument,create=doc.createElement;
    doc.createElement=function(tag,...args){if(tag==='canvas')throw Error('intentional-init-failure');return create.call(this,tag,...args);};
    p.isPaused=false;await pixiLiveControls.enable({backend:'direct-objects'});doc.createElement=create;
    const init={paused:p.isPaused,blocked:p._renderer.render!==originalRootRender,message:document.getElementById('status').textContent};
    document.getElementById('toggle').click();init.restored=p._renderer.render===originalRootRender&&!p.isPaused;p.isPaused=true;
    return {held,restored,context,bridge,init};
  })()`);
  assert.deepEqual(report.failure.held,{failed:true,paused:true,selected:true,blocked:true});
  assert.equal(report.failure.restored,true);
  assert.deepEqual(report.failure.context,{prevented:true,paused:true,selected:true,failed:true});
  assert.deepEqual(report.failure.bridge,{failed:true,selected:true,paused:true,nativeCalls:1});
  assert.equal(report.failure.init.paused,true);
  assert.equal(report.failure.init.blocked,true);
  assert.equal(report.failure.init.restored,true);
  assert.ok(report.failure.init.message.includes('intentional-init-failure'));
  assert.equal(errors.length,3);
  assert.ok(errors[0].includes('intentional-render-failure'));
  assert.ok(errors[1].includes('Pixi graphics context lost'));
  assert.ok(errors[2].includes('intentional-bridge-failure'));
  console.log(JSON.stringify(report, null, 2));
  await writeFile(
    "/tmp/pixi-display-list-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
} finally {
  await send("Page.close").catch(() => {});
  ws.close();
}
