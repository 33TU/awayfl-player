export async function checkNativeText(player, live) {
  let loginTitle;
  function findLoginTitle(node) {
    if(node.assetType==='[asset TextSprite]'&&node.parentTextField?.name==='txtTitle')loginTitle=node;
    for(const child of node._children||[])findLoginTitle(child);
  }
  findLoginTitle(player.root);
  const titleRoot=live.getDisplayObject(loginTitle);
  const rich=[];
  function findRich(node) {
    if(node?.renderPipeId==='htmlText')rich.push(node);
    for(const child of node?.children||[])findRich(child);
  }
  findRich(titleRoot);
  if(rich.length!==1||!rich[0].text.includes('New Release:'))
    throw Error('The login title did not use Pixi HTMLText');
  const htmlTexture=Object.values(rich[0]._gpuData)[0]?.texturePromise;
  if(!htmlTexture)throw Error('Pixi HTMLText did not start texture generation');
  await htmlTexture;
  player._renderer.render();
  const titleCanvas=player._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');
  const titleGL=titleCanvas.getContext('webgl2'),titleBounds=rich[0].getBounds();
  const titleX=Math.floor(titleBounds.x),titleY=Math.floor(titleBounds.y);
  const titleW=Math.ceil(titleBounds.width),titleH=Math.ceil(titleBounds.height);
  const titlePixels=new Uint8Array(titleW*titleH*4);
  titleGL.readPixels(titleX,titleCanvas.height-titleY-titleH,titleW,titleH,titleGL.RGBA,titleGL.UNSIGNED_BYTE,titlePixels);
  let orangePixels=0;
  for(let i=0;i<titlePixels.length;i+=4)
    if(titlePixels[i]>160&&titlePixels[i+1]>60&&titlePixels[i+2]<130&&titlePixels[i+3]>150)orangePixels++;
  if(orangePixels<10)throw Error('Pixi HTMLText texture was not presented after loading');
  const root=player.root._children.find(n=>n.name==='scene').adapter;
  const s=root.sec;
  const field=s.flash.text.TextField.axClass.axConstruct([]);
  field.$BgdefaultTextFormat=new s.flash.text.TextFormat('Arial',24,0xffffff);
  field.$Bgwidth=250;field.$Bgheight=40;
  field.$Bgx=100;field.$Bgy=100;field.$Bgtext='PIXI TEXT';
  root.$BgaddChild(field);
  const textSprite=()=>field.adaptee._children.find(n=>n.assetType==='[asset TextSprite]');
  const pixiText=()=>{
    const outer=live.getDisplayObject(textSprite()),found=[];
    function visit(n){if(n.renderPipeId==='text')found.push(n);for(const c of n.children||[])visit(c);}
    if(outer)visit(outer);
    return found;
  };
  const pixiLines=()=>{
    const outer=live.getDisplayObject(textSprite()),found=[];
    function visit(n){if(['text','htmlText'].includes(n.renderPipeId))found.push(n);for(const c of n.children||[])visit(c);}
    if(outer)visit(outer);
    return found;
  };
  const frame=()=>{player._renderer.render();if(live.stats.lastError)throw Error(live.stats.lastError);};
  function brightPixels() {
    const canvas=player._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');
    const gl=canvas.getContext('webgl2'),bounds=pixiText()[0].getBounds();
    const x=Math.max(0,Math.floor(bounds.x)),y=Math.max(0,Math.floor(bounds.y));
    const w=Math.min(canvas.width-x,Math.ceil(bounds.width));
    const h=Math.min(canvas.height-y,Math.ceil(bounds.height));
    if(w<=0||h<=0)return 0;
    const pixels=new Uint8Array(w*h*4);
    gl.readPixels(x,canvas.height-y-h,w,h,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    let bright=0;
    for(let i=0;i<pixels.length;i+=4)
      if(pixels[i]>230&&pixels[i+1]>230&&pixels[i+2]>230&&pixels[i+3]>200)bright++;
    return bright;
  }
  try {
    frame();
    if(pixiText().length!==1)throw Error('Plain Arial glyphs did not use one Pixi Text');
    if(brightPixels()<10)throw Error('Pixi Text did not draw visible white glyphs');
    const first=pixiText()[0];
    if(first.text!=='PIXI TEXT')throw Error('Pixi Text content mismatch');
    field.$Bgx+=20;frame();
    if(pixiText()[0]!==first)throw Error('Text transform rebuilt Pixi Text');
    field.$BgscaleX=2;field.$BgscaleY=2;frame();
    if(pixiText()[0]!==first||first.resolution<2)
      throw Error('Scaled text did not increase its raster resolution');
    field.$Bgalpha=0.5;frame();
    if(pixiText()[0]!==first||Math.abs(first.alpha-0.5)>0.01)
      throw Error('Text alpha did not update in place');
    field.$Bgtext='UPDATED';frame();
    if(pixiText().length!==1||pixiText()[0].text!=='UPDATED')
      throw Error('Text edit did not update Pixi Text');
    field.$BgscaleX=1;field.$BgscaleY=1;field.$Bgalpha=1;
    field.$Bgwidth=130;field.$Bgheight=120;field.$BgwordWrap=true;
    field.$Bgtext='ONE TWO THREE FOUR FIVE SIX';frame();
    const wrapped=pixiText();
    if(wrapped.length<2||wrapped.length!==field.adaptee.lines_charIdx_start.length||
        wrapped[1].position.y<=wrapped[0].position.y)
      throw Error('Flash-wrapped lines did not become positioned Pixi Text objects');
    field.$Bgheight=180;
    field.$Bgwidth=260;
    field.$BghtmlText='<font face="Arial" size="24" color="#ff0000">R</font><font face="Arial" size="24" color="#ffffff">EDWHITE WORDS MORE AGAIN</font>';
    frame();
    const mixed=pixiLines();
    if(mixed.length<2||!mixed.some(line=>line.renderPipeId==='htmlText'))
      throw Error('Wrapped mixed-color field did not use Pixi HTMLText lines: '+JSON.stringify({
        mask:!!textSprite().mask,found:mixed.map(line=>line.renderPipeId),
        starts:field.adaptee.lines_charIdx_start,ends:field.adaptee.lines_charIdx_end,
      }));
    await Promise.all(mixed.filter(line=>line.renderPipeId==='htmlText').map(line=>
      Object.values(line._gpuData)[0]?.texturePromise));
    frame();
    if(live.stats.lastError)throw Error(live.stats.lastError);
    const mixedBounds=mixed.find(line=>line.renderPipeId==='htmlText').getBounds();
    const mx=Math.floor(mixedBounds.x),my=Math.floor(mixedBounds.y);
    const mw=Math.ceil(mixedBounds.width),mh=Math.ceil(mixedBounds.height);
    const mixedPixels=new Uint8Array(mw*mh*4);
    titleGL.readPixels(mx,titleCanvas.height-my-mh,mw,mh,titleGL.RGBA,titleGL.UNSIGNED_BYTE,mixedPixels);
    let redPixels=0;
    for(let i=0;i<mixedPixels.length;i+=4)
      if(mixedPixels[i]>160&&mixedPixels[i+1]<100&&mixedPixels[i+2]<100&&mixedPixels[i+3]>150)redPixels++;
    if(redPixels<10)throw Error('Wrapped HTMLText line was not presented');
    field.$BgdefaultTextFormat=new s.flash.text.TextFormat('Mini 7_10pt_st',16,0xffffff);
    field.$Bgtext='FALLBACK';frame();
    if(pixiText().length)throw Error('Embedded font did not return to glyph meshes');
    return {loginTitle:true,loginTitlePixels:orangePixels,plain:true,transformReused:true,scaledResolution:true,alphaUpdated:true,edited:true,wrappedLines:wrapped.length,mixedWrappedLines:mixed.length,mixedLinePixels:redPixels,embeddedFallback:true};
  } finally {root.$BgremoveChild(field);frame();}
}
