// Compare retained translation with forced native invalidation of the exact same
// scene. Pixel readbacks belong only to this offline regression.
export async function checkTranslationReuse(player, live) {
  const g = player.root._children.find(n => n.name === "scene").adapter, s = g.sec;
  const hidden = g.adaptee._children.map(n => [n, n.visible]);
  for (const [n] of hidden) n.visible = false;
  const sprite = () => s.flash.display.Sprite.axClass.axConstruct([]);
  const parent = sprite(), mask = sprite();
  g.$BgaddChild(parent); g.$BgaddChild(mask);
  parent.$Bgx = 100; parent.$Bgy = 100;
  parent.$Bggraphics.$BgbeginFill(0x112244);
  parent.$Bggraphics.$BgdrawRect(-5,-5,170,205);
  parent.$Bggraphics.$BgendFill();
  mask.$Bgx = 110; mask.$Bgy = 110;
  mask.$Bggraphics.$BgbeginFill(0xffffff); mask.$Bggraphics.$BgdrawRect(0,0,45,25);
  const children = [];
  for (let i=0;i<64;i++) {
    const child = sprite(); parent.$BgaddChild(child); children.push(child);
    child.$Bgx = i%8*20; child.$Bgy = Math.floor(i/8)*20;
    child.$Bggraphics.$BglineStyle(1,0xffffff,1,false,"none");
    child.$Bggraphics.$BgbeginFill(0x3377bb);
    child.$Bggraphics.$BgdrawRect(0,0,12,12); child.$Bggraphics.$BgendFill();
  }
  // Plain fills have no transform-dependent Pixi content; a parent rotation or
  // scale must retain them while the strokes above are re-prepared.
  const plain = [];
  for (let i=0;i<16;i++) {
    const child = sprite(); parent.$BgaddChild(child); plain.push(child);
    child.$Bgx = i%8*20; child.$Bgy = 165 + Math.floor(i/8)*18;
    child.$Bggraphics.$BgbeginFill(0xbb7733);
    child.$Bggraphics.$BgdrawRect(0,0,12,12); child.$Bggraphics.$BgendFill();
  }
  children[0].$Bgmask = mask;
  children[1].$Bgfilters = s.createArray([new s.flash.filters.GlowFilter(0xff0000,1,4,4,1,1)]);
  const text = s.flash.text.TextField.axClass.axConstruct([]);
  text.$BgdefaultTextFormat = new s.flash.text.TextFormat("Mini 7_10pt_st",16,0xffffff);
  text.$BgembedFonts = true; text.$Bgwidth = 180; text.$Bgheight = 30;
  text.$Bgtext = "TRANSLATION"; text.$Bgy = 170; parent.$BgaddChild(text);
  const canvas = player._view.stage.context._gl.canvas.ownerDocument.querySelector("[data-pixi-display-list]");
  const gl = canvas.getContext("webgl2");
  function frame() {
    player._renderer.render();
    const bytes = new Uint8Array(canvas.width*canvas.height*4);
    gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
    return {bytes,prepared:live.stats.preparedNodes,
      contents:live.stats.preparedContents,retained:live.stats.retainedContents,
      meshes:live.stats.meshes,unsupported:JSON.stringify(Object.entries(live.stats.unsupported).sort())};
  }
  const cases = [];
  try {
    frame(); frame();
    for (const [name,change] of [
      ["translate",()=>{parent.$Bgx+=20;parent.$Bgy+=10;}],
      ["fractional",()=>{parent.$Bgx+=0.25;parent.$Bgy+=0.75;}],
      ["scale",()=>{parent.$BgscaleX=1.5;}],
      ["rotate",()=>{parent.$Bgrotation=12;}],
      ["color",()=>{parent.$Bgalpha=0.6;}],
      ["child-geometry-and-translation",()=>{parent.$Bgx+=10;children[3].$Bggraphics.$BgbeginFill(0xff0000);children[3].$Bggraphics.$BgdrawRect(0,0,18,18);children[3].$Bggraphics.$BgendFill();}],
      ["child-color",()=>{children[4].$Bgalpha=0.35;}],
      ["child-text",()=>{text.$Bgtext="RETAINED CONTENT";}],
      ["parent-geometry",()=>{parent.$Bggraphics.$BgbeginFill(0x228811);parent.$Bggraphics.$BgdrawRect(0,0,50,25);parent.$Bggraphics.$BgendFill();}],
      ["child-remove",()=>{parent.$BgremoveChild(children[5]);}],
      ["child-reattach",()=>{parent.$BgaddChild(children[5]);}],
      ["mask-and-translation",()=>{parent.$Bgx-=10;mask.$Bgx+=12;}],
      ["hide",()=>{parent.$Bgvisible=false;}],
      ["show",()=>{parent.$Bgvisible=true;}],
    ]) {
      change(); const retained = frame();
      parent.adaptee._invalidateHierarchicalProperty(255);
      const forced = frame();
      let maxDelta = 0;
      for (let i=0;i<retained.bytes.length;i++) maxDelta=Math.max(maxDelta,Math.abs(retained.bytes[i]-forced.bytes[i]));
      cases.push({name,maxDelta,retainedPrepared:retained.prepared,forcedPrepared:forced.prepared,
        retainedContents:retained.retained,preparedContents:retained.contents,forcedContents:forced.contents});
      if(retained.meshes!==forced.meshes)throw Error(`Content summary regression ${name}`);
      if(retained.unsupported!==forced.unsupported)throw Error(`Content diagnostics regression ${name}`);
      if(maxDelta)throw Error(`Translation regression ${name}: pixel delta ${maxDelta}`);
    }
    return {cases,translationReuses:live.stats.translationReuses};
  } finally {
    children[0].$Bgmask = null;
    g.$BgremoveChild(parent);g.$BgremoveChild(mask);
    for(const [n,visible] of hidden)n.visible=visible;
    player._renderer.render();
  }
}
