const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
function load(file, imports = {}) {
    const exports = {};
    new Function('require', 'exports', ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText)(id => imports[id] || {}, exports);
    return exports;
}
const { RenderTargetWebGL } = load('stage/lib/webgl/RenderTargetWebGL.ts');
const { RenderTargetWebGLMSAA } = load('stage/lib/webgl/RenderTargetWebGLMSAA.ts', {
    './RenderTargetWebGL': { RenderTargetWebGL },
});
const { TextureContextWebGL } = load('stage/lib/webgl/TextureContextWebGL.ts');
const framebuffers = new Set(), buffers = new Set();
const gl = {
    createFramebuffer() { const f = {}; framebuffers.add(f); return f; },
    createRenderbuffer() { const b = {}; buffers.add(b); return b; },
    deleteFramebuffer(f) { framebuffers.delete(f); },
    deleteRenderbuffer(b) { buffers.delete(b); },
    bindFramebuffer(target, f) { assert.ok(!f || framebuffers.has(f), 'never restore a deleted framebuffer'); },
    bindRenderbuffer() {}, framebufferRenderbuffer() {}, renderbufferStorage() {},
    renderbufferStorageMultisample() {}, getParameter() { return 4; }, deleteTexture() {},
};
const context = { _gl: gl, stats: { counter: { renderTarget: 0 }, memory: { renderTarget: 0 } } };
const tex = context._texContext = Object.create(TextureContextWebGL.prototype);
tex._gl = gl;
tex._context = context;
tex._currentRT = null;
// Repeated resize/dispose, including disposal of the currently bound target.
for (let i = 0; i < 20; i++) {
    const resolve = new RenderTargetWebGL(context, 256 + i, 256, false);
    const msaa = new RenderTargetWebGLMSAA(context, 256 + i, 256, false);
    msaa.linkTarget(resolve);
    tex.bindRenderTarget(msaa);
    const texture = { _glTexture: {}, _renderTarget: msaa };
    tex.disposeTexture(texture);
    assert.equal(texture._renderTarget, null);
    assert.equal(tex._currentRT, null);
    assert.equal(framebuffers.size, 0, 'resolve framebuffer must be released with MSAA framebuffer');
    assert.equal(buffers.size, 0, 'color and both depth/stencil buffers must be released');
    assert.equal(context.stats.counter.renderTarget, 0);
    assert.equal(context.stats.memory.renderTarget, 0);
    msaa.dispose();
    assert.equal(context.stats.counter.renderTarget, 0);
    assert.equal(context.stats.memory.renderTarget, 0);
}
console.log('Passed: resizing releases MSAA and resolve resources, clears stale bindings, and tolerates repeated disposal.');

class Image2D {
    constructor(width, height) { Object.assign(this, { width, height, disposed: false }); }
    dispose() { this.disposed = true; }
}
class Rectangle {}
class Point {}
const filters = Object.fromEntries(['DisplacementFilter', 'BlurFilter', 'BevelFilter', 'ThresholdFilter',
    'ColorMatrixFilter', 'DropShadowFilter'].map(name => [name, { filterName: name }]));
const { FilterManager } = load('stage/lib/managers/FilterManager.ts', {
    '@awayjs/core': { Rectangle, Point }, '../image/': { Image2D }, '../filters': filters,
    '../utils/ImageUtils': { default: { MAX_SIZE: 8192 } },
});
const manager = new FilterManager({ context: { glVersion: 2 } });
const idle = manager.popTemp(100, 100, true);
const busy = manager.popTemp(100, 100, true);
manager.pushTemp(idle);
manager.clearTempPool();
assert.equal(idle.disposed, true);
assert.equal(busy.disposed, false, 'in-flight nested targets must survive a pool clear');
manager.pushTemp(busy);
assert.equal(manager.popTemp(100, 100, true), busy);
manager.pushTemp(busy);
manager.clearTempPool();
assert.equal(busy.disposed, true);
assert.notEqual(manager.popTemp(100, 100, true), busy);
console.log('Passed: clearing temporary filter buffers disposes idle targets without destroying checked-out targets.');
