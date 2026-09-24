// Browser-only regression fixtures. Pixel downloads are deliberately confined
// to this test module, never the live adapter.
import { createLiveRenderer } from "./live-renderer.mjs";
import { createFilterPasses } from "./filter-passes.mjs";
import { saveGL, mirrorGL, createTransport } from "./shared-gl.mjs";
export { checkRenderer } from "./check-renderer-browser.mjs";
export { checkFlashBlend } from "./check-blend-browser.mjs";

export async function checkFilters(player) {
  const stage = player._view.stage,
    gl = stage.context._gl,
    manager = stage.filterManager;
  const paused = player.isPaused;
  player.isPaused = true;
  stage.pushRenderTargetConfig();
  const restore = saveGL(gl);
  const live = await createLiveRenderer(gl);
  restore();
  const unmirror = mirrorGL(gl, stage.context),
    transport = createTransport(gl);
  const filters = createFilterPasses(stage, live, transport);
  const source = manager.popTemp(96, 64),
    output = manager.popTemp(96, 64);
  const original = manager.drawTask;
  const hadOwn = Object.hasOwn(manager, "drawTask");
  const results = [];
  let usePixi = false,
    fallback = 0;
  manager.drawTask = function (task) {
    if (usePixi && filters.draw(task)) return;
    if (
      usePixi &&
      (task.name === "DropShadowTask" ||
        task.name?.startsWith("FilterBlurTask:"))
    )
      fallback++;
    return original.call(this, task);
  };
  const native = (image) =>
    stage.abstractions.getAbstraction(image).getTexture();
  function pixels(output) {
    stage.setRenderTarget(output, false, 0, 0, true);
    const bytes = new Uint8Array(output.width * output.height * 4);
    gl.readPixels(
      0,
      0,
      output.width,
      output.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      bytes,
    );
    return bytes;
  }
  const defaults = {
    filterName: "dropShadow",
    blurX: 9,
    blurY: 5,
    quality: 2,
    imageScale: 1,
    color: 0x487cde,
    alpha: 0.75,
    strength: 1.8,
    angle: 37,
    distance: 5,
    inner: false,
    knockout: false,
    hideObject: false,
  };
  const cases = [
    ["outer glow", { filterName: "glow" }],
    ["shadow", {}],
    ["inner", { inner: true }],
    ["knockout", { knockout: true }],
    ["inner knockout", { inner: true, knockout: true }],
    ["hide object", { hideObject: true }],
    ["inner hide object", { inner: true, hideObject: true }],
    ["quality 1", { quality: 1 }],
    ["quality 3", { quality: 3 }],
    ["zero blur", { blurX: 0, blurY: 0 }],
    ["scaled", { imageScale: 1.75 }],
    ["negative distance", { distance: -7, angle: 125 }],
    ["transparent", { alpha: 0 }],
    ["blur", { filterName: "blur" }],
    ["cropped", {}, "cropped"],
    ["in place", {}, "inPlace"],
    [
      "filter chain",
      [{ filterName: "glow" }, { inner: true, color: 0x55cc22 }],
    ],
  ];
  try {
    const data = new Uint8Array(source.width * source.height * 4);
    for (let y = 9; y < 42; y++)
      for (let x = 13; x < (y < 22 ? 43 : 30); x++) {
        const a = (x + y) % 4 === 0 ? 96 : 255,
          i = (y * source.width + x) * 4;
        data.set([a, Math.round(a * 0.3), Math.round(a * 0.1), a], i);
      }
    for (const [name, props, variant] of cases) {
      const options = (Array.isArray(props) ? props : [props]).map((p) => ({
        ...defaults,
        ...p,
      }));
      const target = variant === "inPlace" ? source : output;
      const inputRect = source.rect.clone(),
        destRect = target.rect.clone();
      if (variant === "cropped") {
        inputRect.setTo(7, 3, 43, 35);
        destRect.setTo(12, 8, 43, 35);
      }
      usePixi = false;
      native(source).uploadFromArray(data, 0, true);
      manager.applyFilters(source, target, inputRect, destRect, options);
      const reference = pixels(target);
      usePixi = true;
      native(source).uploadFromArray(data, 0, true);
      manager.applyFilters(source, target, inputRect, destRect, options);
      const actual = pixels(target);
      if (name === "outer glow") {
        // Keep reusable filter shaders alive while their inputs age past the
        // borrowed texture sweep, then run the same pass again.
        const restoreIdle = saveGL(gl);
        for (let i = 0; i < 125; i++)
          live.render({
            width: gl.drawingBufferWidth,
            height: gl.drawingBufferHeight,
            commands: [],
          });
        restoreIdle();
        manager.applyFilters(source, target, inputRect, destRect, options);
        const resumed = pixels(target);
        if (resumed.some((v, i) => v !== actual[i]))
          throw Error("Filter changed after idle texture cleanup");
      }
      let max = 0,
        sum = 0,
        changed = 0;
      for (let i = 0; i < actual.length; i++) {
        const d = Math.abs(actual[i] - reference[i]);
        max = Math.max(max, d);
        sum += d;
        if (d) changed++;
      }
      results.push({ name, max, mean: sum / actual.length, changed });
    }
    return {
      results,
      stats: { ...filters.stats },
      fallback,
      glError: gl.getError(),
    };
  } finally {
    if (hadOwn) manager.drawTask = original;
    else delete manager.drawTask;
    manager.pushTemp(source);
    manager.pushTemp(output);
    filters.destroy();
    live.destroy();
    transport.destroy();
    stage.popRenderTarget();
    restore();
    unmirror();
    player.isPaused = paused;
  }
}

export { checkBatchRendering } from "./check-batch-browser.mjs";
