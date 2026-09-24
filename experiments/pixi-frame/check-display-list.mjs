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
      message.includes("[Pixi display list]") ||
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
    url: "https://localhost:4433/game/gamefiles/pixi-benchmark/play.html?autostart=0&renderScale=0&backend=display-list",
  });
  await until(
    '!!window.pixiLiveControls?.player?.root?._children.find(n=>n.name==="scene")?.adapter?.$BgmcLogin',
  );
  report.login = await evaluate(`(async()=>{
    const p=pixiLiveControls.player;p.isPaused=true;
    window.originalRootRender=p._renderer.render;
    p._renderer.render=()=>{throw Error('AwayFL root renderer called by direct display list')};
    await pixiLiveControls.enable();
    for(let i=0;i<5;i++)p._renderer.render();
    const builds=pixiLive.stats.geometryBuilds,uploads=pixiLive.stats.textureUploads;
    for(let i=0;i<5;i++)p._renderer.render();
    return {stats:structuredClone(pixiLive.stats),geometryReused:builds===pixiLive.stats.geometryBuilds,texturesReused:uploads===pixiLive.stats.textureUploads};
  })()`);
  assert.equal(report.login.stats.active, true);
  assert.equal(report.login.stats.lastError, null);
  assert.equal(report.login.stats.mode, "display-list");
  assert.ok(report.login.stats.meshes > 100);
  assert.equal(report.login.geometryReused, true);
  assert.equal(report.login.texturesReused, true);
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
    box.$BgblendMode='overlay';const overlayPixels=effect();box.$BgblendMode='normal';g.$BgremoveChild(backdrop);
    box.$Bggraphics.$Bgclear();box.$Bggraphics.$BgbeginFill(0x00ff00);box.$Bggraphics.$BgdrawRect(0,0,60,40);box.$Bggraphics.$BgendFill();p._renderer.render();
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
    return {overlayPixels,shared,red,moved,transformReused,green,hidden,clipped,masked,unmasked,removed,readded,glowPixels,strongerGlow,qualityGlow,knockoutGlow,innerGlow,shadowPixels,matrixPixels,changedMatrix,bevelPixels,blurPixels,clearedGlow,bitmapBlue,bitmapGreen,bitmapRed,gpuBitmap,gpuReported,stats:structuredClone(pixiLive.stats)};
  })()`);
  const black = [0, 0, 0, 255],
    red = [255, 0, 0, 255],
    green = [0, 255, 0, 255];
  assert.deepEqual(
    report.pixels.overlayPixels.inside,
    red,
    "overlay uses the backdrop instead of normal blending",
  );
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
    function count(){p._renderer.render();const frame=readOutlineFrame();let red=0,white=0;
      for(let y=94;y<145;y++)for(let x=200;x<450;x++){const v=outlinePixel(x,y,frame);if(v[0]>40&&v[1]<10&&v[2]<10)red++;if(v[0]>240&&v[1]>240&&v[2]>240)white++;}
      return {red,white};}
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
  assert.ok(report.textOutline.changed.red > 10);
  assert.ok(report.textOutline.changed.white > 10);
  assert.deepEqual(
    report.textOutline.chatBorder,
    report.textOutline.changed,
    "strong zero-offset chat shadows use the same crisp border as name glows",
  );
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
    p._renderer.render();return {canvasRemoved:!p._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]'),restored,active:pixiLive.stats.active};})()`);
  assert.equal(report.stop.canvasRemoved, true);
  assert.equal(report.stop.active, false);
  assert.equal(report.stop.restored, true);
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
    for(let i=0;i<4;i++)p._renderer.render();
    return {gpuReported,stats:structuredClone(pixiLive.stats)};
  })()`);
  assert.ok(report.battleon.gpuReported > 0);
  assert.equal(report.battleon.stats.active, true);
  assert.equal(report.battleon.stats.lastError, null);
  assert.ok(report.battleon.stats.meshes > 1000);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify(report, null, 2));
  await writeFile(
    "/tmp/pixi-display-list-check.json",
    JSON.stringify(report, null, 2) + "\n",
  );
} finally {
  await send("Page.close").catch(() => {});
  ws.close();
}
