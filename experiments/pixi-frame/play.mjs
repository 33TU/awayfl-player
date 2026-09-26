import { loadBattleonFixture } from "./fixture.mjs";
import { startLive } from "./live.mjs";
import { startDisplayList } from "./display-list.mjs";
const iframe = document.getElementById("player"),
  button = document.getElementById("toggle"),
  status = document.getElementById("status");
const params = new URLSearchParams(location.search);
if (!params.has("renderScale")) params.set("renderScale", "1.5");
if (!params.has("fps")) params.set("fps", "1");
const backend = params.get("backend") || "bridge";
const groupVertexLimit = Number(params.get("groupVertexLimit"));
params.delete("backend");
params.delete("autostart");
iframe.src = (params.get("nativeGraphics") === "1" ? "./loader-native.html?" : "/game/gamefiles/loader-awayfl.html?") + params;
let bridge,
  player,
  ready,
  autoStart,
  busy = false,
  failedStart;
function onStatus(message, stats) {
  status.textContent = message;
  status.title = JSON.stringify(stats, null, 2);
  button.textContent = bridge?.active ? "Use AwayFL" : "Enable Pixi";
}
async function enable(options = {}) {
  if (busy || failedStart || bridge?.active || !player) return;
  busy = true;
  button.disabled = true;
  const target = player;
  try {
    const selected = options.backend || backend;
    const start =
      ["display-list", "direct-objects"].includes(selected)
        ? startDisplayList
        : startLive;
    const created = await start(target, { ...options, nativeGraphics: options.nativeGraphics ?? params.get("nativeGraphics") === "1", shapeSprites: options.shapeSprites ?? params.get("shapeSprites") === "1", nativeText: options.nativeText ?? (params.get("nativeText") === "1" || (params.get("nativeText") !== "0" && params.get("nativeGraphics") === "1")), pixiBitmapDraw: options.pixiBitmapDraw ?? params.get("pixiBitmapDraw") === "1", idleHoverHz: options.idleHoverHz ?? (params.has("idleHoverHz") ? Number(params.get("idleHoverHz")) : 12), retainedHover: options.retainedHover ?? params.get("retainedHover") !== "0", pixiPickBounds: options.pixiPickBounds ?? params.get("pixiPickBounds") === "1", pixiEvents: options.pixiEvents ?? params.get("pixiEvents") === "1", pixiEventsScopedPress: options.pixiEventsScopedPress ?? params.get("pixiEventsScopedPress") !== "0", pixiEventsCull: options.pixiEventsCull ?? params.get("pixiEventsCull") === "1", effectTextures: options.effectTextures ?? params.get("effectTextures") === "1", directMultiBlend: options.directMultiBlend ?? params.get("directMultiBlend") !== "0", reuseLinear: options.reuseLinear ?? params.get("reuseLinear") !== "0", arrivalBudgetMs: options.arrivalBudgetMs ?? (params.has("arrivalBudget") ? Number(params.get("arrivalBudget")) : undefined), arrivalMaxFrames: options.arrivalMaxFrames ?? (params.has("arrivalFrames") ? Number(params.get("arrivalFrames")) : undefined), arrivalFreezeMs: options.arrivalFreezeMs ?? (params.has("arrivalFreeze") ? Number(params.get("arrivalFreeze")) : undefined), instancedTransforms: options.instancedTransforms ?? params.get("instanced") !== "0", arrivalHide: options.arrivalHide ?? params.get("arrivalHide") === "1", isolateNeighbors: options.isolateNeighbors ?? (params.has("isolateNeighbors") ? Number(params.get("isolateNeighbors")) : undefined), antialias: options.antialias ?? params.get("antialias") !== "0", bezierSmoothness: options.bezierSmoothness ?? (params.has("bezierSmoothness") ? Number(params.get("bezierSmoothness")) : undefined), catchUp: options.catchUp ?? params.get("catchUp") === "1", retainPaths: options.retainPaths ?? (params.has("retainPaths") ? Number(params.get("retainPaths")) : undefined), retainGeometry: options.retainGeometry ?? (params.has("retainGeometry") ? Number(params.get("retainGeometry")) : undefined), directObjects: selected === "direct-objects", cacheScenery: options.cacheScenery ?? params.get("cacheScenery") !== "0", vectorBatching: options.vectorBatching ?? params.get("vectorBatching") !== "0", boundedBlends: options.boundedBlends ?? params.get("boundedBlends") !== "0", renderGroups: options.renderGroups ?? params.get("renderGroups") !== "0", groupVertexLimit: options.groupVertexLimit ?? (Number.isInteger(groupVertexLimit) && groupVertexLimit >= 0 && groupVertexLimit <= 100000 && params.has("groupVertexLimit") ? groupVertexLimit : undefined), onStatus });
    if (player !== target) {
      created.stop();
      return;
    }
    bridge = created;
    window.pixiLive = bridge;
    button.textContent = "Use AwayFL";
  } catch (e) {
    console.error(e);
    // Initialization errors must not silently leave the game using AwayFL.
    const original = target._renderer.render, paused = target.isPaused;
    const blocked = () => {};
    target._renderer.render = blocked;
    target.isPaused = true;
    failedStart = () => {
      if (target._renderer.render === blocked) target._renderer.render = original;
      target.isPaused = paused;
    };
    status.textContent = "Pixi could not start: " + e.message + ". Reload to retry or select Use AwayFL.";
    button.textContent = "Use AwayFL";
  } finally {
    busy = false;
    button.disabled = !player;
  }
}
button.onclick = () => {
  if (failedStart) {
    failedStart();failedStart=null;
    status.textContent = "AwayFL renderer active";
    button.textContent = "Enable Pixi";
  } else if (bridge?.active) {
    bridge.stop();
    button.textContent = "Enable Pixi";
  } else enable();
};
function watchPlayer() {
  clearInterval(ready);
  clearTimeout(autoStart);
  failedStart?.();failedStart=null;
  bridge?.stop();
  bridge = null;
  player = null;
  window.pixiLive = null;
  button.disabled = true;
  status.textContent = "Waiting for AwayFL…";
  ready = setInterval(() => {
    player = iframe.contentWindow._AWAY_DEBUG_PLAYER_?.player;
    if (
      !player?._renderer ||
      !player.root?._children?.some((n) => n.name === "scene")
    )
      return;
    clearInterval(ready);
    button.disabled = false;
    status.textContent = "AwayFL ready";
    // Let the initial SWF frame construct its cached renderers before attaching.
    if (new URLSearchParams(location.search).get("autostart") !== "0")
      autoStart = setTimeout(enable, 1500);
  }, 250);
}
iframe.addEventListener("load", watchPlayer);
watchPlayer();
window.pixiLiveControls = {
  enable,
  loadFixture: (options) => loadBattleonFixture(player, options),
  get player() {
    return player;
  },
  stop() {
    if (failedStart) { failedStart();failedStart=null;onStatus("AwayFL renderer active", {}); }
    bridge?.stop();
  },
};
window.addEventListener("pagehide", () => {
  failedStart?.();failedStart=null;
  clearInterval(ready);
  clearTimeout(autoStart);
  bridge?.stop();
});
