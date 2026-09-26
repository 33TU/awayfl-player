// Isolate color invalidation from filter-cache/MSAA rounding. The separate
// translation/filter suite covers transformed, filtered inherited paint.
export async function checkColorUpdates(player, live) {
  const g=player.root._children.find(n=>n.name==='scene').adapter,s=g.sec;
  const hidden=g.adaptee._children.map(n=>[n,n.visible]);
  for(const [n] of hidden)n.visible=false;
  const sprite=()=>s.flash.display.Sprite.axClass.axConstruct([]);
  const parent=sprite();g.$BgaddChild(parent);parent.$Bgx=100;parent.$Bgy=100;
  function rect(n,color,width=12){n.$Bggraphics.$BgbeginFill(color);n.$Bggraphics.$BgdrawRect(0,0,width,12);n.$Bggraphics.$BgendFill();}
  const children=[];
  for(let i=0;i<32;i++){const c=sprite();children.push(c);parent.$BgaddChild(c);c.$Bgx=i%8*20;c.$Bgy=Math.floor(i/8)*20;rect(c,0x2266cc);}
  const canvas=player._view.stage.context._gl.canvas.ownerDocument.querySelector('[data-pixi-display-list]');
  const gl=canvas.getContext('webgl2');
  function frame(){player._renderer.render();const bytes=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);return {bytes,prepared:live.stats.preparedContents,nodes:live.stats.preparedNodes};}
  const cases=[],initial=live.stats.unchangedColorUpdates;
  const repeat=()=>parent.adaptee.transform.invalidateColorTransform();
  try {
    frame();frame();
    for(const [name,change,expect] of [
      ['same-color',repeat,'none'],
      ['changed-then-repeat',()=>{parent.$Bgalpha=0.5;repeat();},'all'],
      ['geometry-then-repeat',()=>{rect(children[0],0xff7700,18);children[0].adaptee.transform.invalidateColorTransform();},'some'],
      ['color-offset',()=>{parent.adaptee.transform.colorTransform._rawData[4]=55;repeat();},'all'],
      ['repeat-offset',repeat,'none'],
      ['color-reset',()=>{parent.adaptee.transform.colorTransform=null;repeat();},'all'],
      ['mixed-flags',()=>parent.adaptee._invalidateHierarchicalProperty(48),'all'],
    ]) {
      change();const actual=frame();parent.adaptee._invalidateHierarchicalProperty(255);const forced=frame();
      let maxDelta=0;
      for(let i=0;i<actual.bytes.length;i++)maxDelta=Math.max(maxDelta,Math.abs(actual.bytes[i]-forced.bytes[i]));
      if(maxDelta)throw Error(`Color update ${name}: pixel delta ${maxDelta}`);
      if(expect==='none'&&(actual.prepared||actual.nodes))throw Error(`Repeated color scheduled preparation: ${name}`);
      if(expect==='all'&&actual.prepared<32)throw Error(`Inherited paint update skipped: ${name}`);
      if(expect==='some'&&actual.prepared<1)throw Error('Pending geometry update skipped');
      cases.push({name,maxDelta,prepared:actual.prepared,forced:forced.prepared});
    }
    return {cases,unchangedColorUpdates:live.stats.unchangedColorUpdates-initial};
  } finally {g.$BgremoveChild(parent);for(const [n,v] of hidden)n.visible=v;player._renderer.render();}
}
