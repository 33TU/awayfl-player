// Pixi 8.21 WebGL: backdrop filters resolve the entire MSAA target before
// copying a small rectangle, and again after compositing into the backbuffer.
// Resolve just the copied rectangle; the final canvas blit still resolves the
// complete backbuffer. Keep ordinary filter outputs immediately sampleable.
export function installBlendResolve(renderer, stats) {
  const filter = renderer.filter, adaptor = renderer.renderTarget.adaptor;
  let preparing = 0, applying = 0, copying = null;
  Object.assign(stats, { blendResolvePixels: 0, blendResolveSavedPixels: 0 });
  const originals = [];
  function wrap(object, key, implementation) {
    const original = object[key];
    const wrapped = implementation(original);
    object[key] = wrapped;
    originals.push(() => { if (object[key] === wrapped) object[key] = original; });
  }
  wrap(filter, '_setupFilterTextures', original => function (...args) {
    preparing++;
    try { return original.apply(this, args); } finally { preparing--; }
  });
  wrap(filter, '_setupBindGroupsAndRender', original => function (...args) {
    applying++;
    try { return original.apply(this, args); } finally { applying--; }
  });
  wrap(adaptor, 'copyToTexture', original => function (source, destination, origin, size, ...rest) {
    const previous = copying;
    copying = { source, origin, size };
    try { return original.call(this, source, destination, origin, size, ...rest); }
    finally { copying = previous; }
  });
  wrap(adaptor, 'finishRenderPass', original => function (target) {
    const gpu = renderer.renderTarget.getGpuRenderTarget(target);
    if (!gpu.msaa || !target.colorAttachments.length) return original.call(this, target);
    const fullPixels = gpu.width * gpu.height;
    if (copying?.source === target) {
      const { origin: { x, y }, size: { width, height } } = copying;
      if (!(width > 0 && height > 0)) return original.call(this, target);
      const gl = renderer.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, gpu.resolveTargetFramebuffer);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, gpu.framebuffer);
      gl.blitFramebuffer(x, y, x + width, y + height,
        x, y, x + width, y + height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.FRAMEBUFFER, gpu.framebuffer);
      this._boundFramebuffer = gpu.framebuffer;
      stats.blendResolvePixels += width * height;
      stats.blendResolveSavedPixels += fullPixels - width * height;
      return;
    }
    const backbuffer = renderer.backBuffer?._backBufferTexture;
    if (preparing || (applying && backbuffer && target.colorTexture === backbuffer.source)) {
      stats.blendResolveSavedPixels += fullPixels;
      return;
    }
    return original.call(this, target);
  });
  return () => { for (const restore of originals.reverse()) restore(); };
}
