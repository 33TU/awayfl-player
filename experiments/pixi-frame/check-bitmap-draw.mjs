// Disposable browser tab; no login or game connection is needed.
import assert from "node:assert/strict";

const endpoint = process.env.CDP_URL || "http://localhost:9234";
const target = await (await fetch(endpoint + "/json/new?about:blank", { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 0;
const pending = new Map();
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (!message.id) return;
  const finish = pending.get(message.id);
  pending.delete(message.id);
  message.error ? finish.reject(Error(JSON.stringify(message.error))) : finish.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  pending.set(++id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails)
    throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
try {
  await send("Security.setIgnoreCertificateErrors", { ignore: true });
  await send("Page.navigate", { url: "https://localhost:4433/game/gamefiles/pixi-benchmark/play.html?autostart=0&renderScale=1&backend=direct-objects&nativeGraphics=1&pixiBitmapDraw=1" });
  const deadline = Date.now() + 60000;
  while (!await evaluate('!!window.pixiLiveControls?.player?.root?._children.find(n=>n.name==="scene")?.adapter?.$BgmcLogin')) {
    if (Date.now() > deadline) throw Error("Login fixture timed out");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const result = await evaluate(`(async()=>{
    const player=pixiLiveControls.player;
    player.isPaused=true;
    await pixiLiveControls.enable();
    const test=await import('./check-bitmap-draw-browser.js');
    return test.checkBitmapDraw(player,pixiLive);
  })()`);
  assert.equal(result.pixiDraws, 2);
  assert.deepEqual(result.nestedPixels, result.awayPixels);
  const battleon = await evaluate(`(async()=>{
    const player=pixiLiveControls.player;
    player.isPaused=false;
    await pixiLiveControls.enable();
    const test=await import('./check-bitmap-draw-browser.js');
    return test.checkBattleonBitmapDraw(player,pixiLive);
  })()`);
  assert.equal(battleon.pixiDraws, 1);
  assert.ok(battleon.meanChannelError < 15);
  console.log(JSON.stringify({ nested: result, battleon }));
} finally {
  await send("Page.close").catch(() => {});
  ws.close();
}
