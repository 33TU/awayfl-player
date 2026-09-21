import { loadBattleonFixture } from "./fixture.mjs";
import { startLive } from "./live.mjs";
const iframe = document.getElementById("player"),
  button = document.getElementById("toggle"),
  status = document.getElementById("status");
const params = new URLSearchParams(location.search);
if (!params.has("renderScale")) params.set("renderScale", "1.5");
if (!params.has("fps")) params.set("fps", "1");
params.delete("autostart");
iframe.src = "/game/gamefiles/loader-awayfl.html?" + params;
let bridge,
  player,
  ready,
  autoStart,
  busy = false;
function onStatus(message, stats) {
  status.textContent = message;
  status.title = JSON.stringify(stats, null, 2);
  button.textContent = bridge?.active ? "Use AwayFL" : "Enable Pixi";
}
async function enable(options = {}) {
  if (busy || bridge?.active || !player) return;
  busy = true;
  button.disabled = true;
  const target = player;
  try {
    const created = await startLive(target, { ...options, onStatus });
    if (player !== target) {
      created.stop();
      return;
    }
    bridge = created;
    window.pixiLive = bridge;
    button.textContent = "Use AwayFL";
  } catch (e) {
    console.error(e);
    status.textContent = "Could not start Pixi: " + e.message;
  } finally {
    busy = false;
    button.disabled = !player;
  }
}
button.onclick = () => {
  if (bridge?.active) {
    bridge.stop();
    button.textContent = "Enable Pixi";
  } else enable();
};
function watchPlayer() {
  clearInterval(ready);
  clearTimeout(autoStart);
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
  loadFixture: () => loadBattleonFixture(player),
  get player() {
    return player;
  },
  stop() {
    bridge?.stop();
  },
};
window.addEventListener("pagehide", () => {
  clearInterval(ready);
  clearTimeout(autoStart);
  bridge?.stop();
});
