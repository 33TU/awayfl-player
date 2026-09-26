// Backend micro-benchmark: the same synthetic scene on Pixi's WebGL and WebGPU
// renderers. Many small animated Graphics in several render groups, a few
// alpha-filtered groups, transforms changing every frame: roughly the shape
// of an AQW combat frame's Pixi work, without AwayFL. Reports CPU time spent
// in renderer.render per frame (median and p90) for each backend.
import { WebGLRenderer, WebGPURenderer, Container, Graphics, AlphaFilter } from "pixi.js";

const params = new URLSearchParams(location.search);
const COUNT = Number(params.get("count") || 3000), GROUPS = Number(params.get("groups") || 60);
const FILTERED = Number(params.get("filtered") || 12), FRAMES = Number(params.get("frames") || 240);
const out = document.getElementById("out");
const log = line => { out.textContent += line + "\n"; };

function buildScene() {
  const root = new Container(), items = [];
  for (let g = 0; g < GROUPS; g++) {
    const group = new Container();
    if (g % 2 === 0) group.enableRenderGroup();
    if (g < FILTERED) group.filters = [new AlphaFilter({ alpha: 0.9 })];
    group.x = (g % 8) * 150; group.y = Math.floor(g / 8) * 150;
    root.addChild(group);
    for (let i = 0; i < COUNT / GROUPS; i++) {
      const shape = new Graphics().moveTo(0, 0).bezierCurveTo(20, -10, 30, 30, 10, 40).lineTo(-5, 20).closePath()
        .fill({ color: (i * 2654435761) & 0xffffff, alpha: 0.9 });
      shape.x = (i % 10) * 14; shape.y = Math.floor(i / 10) * 14;
      group.addChild(shape); items.push(shape);
    }
  }
  return { root, items };
}

async function run(Renderer, name) {
  const canvas = document.createElement("canvas");
  canvas.width = 1280; canvas.height = 720; document.body.appendChild(canvas);
  const renderer = new Renderer();
  try { await renderer.init({ canvas, width: 1280, height: 720, antialias: true, background: 0x202020 }); }
  catch (e) { log(`${name}: unavailable (${e.message || e})`); canvas.remove(); return null; }
  const { root, items } = buildScene();
  const times = [];
  for (let f = 0; f < FRAMES + 30; f++) {
    for (let i = 0; i < items.length; i++) {
      const s = items[i]; s.rotation = f * 0.02 + i; s.scale.set(1 + 0.2 * Math.sin(f * 0.1 + i));
      if (i % 20 === f % 20) s.visible = !s.visible; // occasional structural changes
    }
    const t0 = performance.now();
    renderer.render(root);
    const t1 = performance.now();
    if (f >= 30) times.push(t1 - t0);
    await new Promise(r => requestAnimationFrame(r));
  }
  times.sort((a, b) => a - b);
  const q = p => times[Math.floor(times.length * p)].toFixed(2);
  const result = { name, median: +q(0.5), p90: +q(0.9) };
  log(`${name}: render() median ${result.median} ms, p90 ${result.p90} ms  (${COUNT} shapes, ${GROUPS} groups, ${FILTERED} filtered)`);
  renderer.destroy(); canvas.remove();
  return result;
}

(async () => {
  log(`navigator.gpu: ${!!navigator.gpu}`);
  const gl = await run(WebGLRenderer, "WebGL");
  const gpu = await run(WebGPURenderer, "WebGPU");
  if (gl && gpu) log(`WebGPU / WebGL median: ${(gpu.median / gl.median).toFixed(2)}x`);
  window.benchDone = { gl, gpu };
})();
