const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
global.self = globalThis;
global.window = globalThis;
const core = require('@awayjs/core');
function load(file, imports) {
    const out = {};
    new Function('require', 'exports', ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../..', file), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES5, module: ts.ModuleKind.CommonJS },
    }).outputText)(name => imports[name] || {}, out);
    return out;
}
class RendererBase {
    render() { this.events.push('source'); if (this.fail === 'source') throw Error('source'); }
}
const { CacheRenderer } = load('renderer/lib/CacheRenderer.ts', {
    '@awayjs/core': core, '@awayjs/stage': { Settings: { ENABLE_MULTISAMPLE_TEXTURE: true } },
    './RendererBase': { RendererBase }, './base/_Render_RenderableBase': { _Render_RenderableBase: class {} },
    './DefaultRenderer': { DefaultRenderer: { registerMaterial() {} } },
    './RenderGroup': { RenderGroup: { getInstance: () => ({ registerMaterial() {} }) } },
    './base/RenderEntity': { RenderEntity: { registerRenderable() {} } },
});
function check(glVersion, filters, fail) {
    const image = () => ({ width: 20, height: 10, rect: new core.Rectangle(0, 0, 20, 10) });
    const target = image(), savedTarget = image(), savedProjection = {}, allocated = [], released = [], events = [];
    const parent = { view: { target: savedTarget, projection: savedProjection },
        _initRender(im) { this.view.target = im; },
        executeRender() { events.push('backdrop'); if (fail === 'backdrop') throw Error(fail); },
        resetHead() { events.push('reset'); },
    };
    const manager = {
        popTemp(w, h, msaa) { assert.equal(!!msaa, glVersion === 2 && allocated.length < 2); const im = image(); allocated.push(im); return im; },
        pushTemp(im) { released.push(im); },
        applyFilters(src, dst) { assert.notEqual(dst, target, 'filtering must preserve backdrop'); events.push('filter'); return true; },
        copyPixels(src, dst, rect, point, merge, mode) { assert.notEqual(src, dst); assert.equal(dst, target); if (mode) { assert.equal(mode, 'overlay'); assert.equal(merge, true); events.push('composite'); } },
    };
    const cache = Object.assign(Object.create(CacheRenderer.prototype), {
        _style: { image: target }, node: { container: { blendMode: 'overlay', filters: filters ? [{}] : null } },
        useNonNativeBlend: true, parentRenderer: parent, fail, events,
        getPaddedBounds: () => target.rect, getBoundsScale: () => 1, _initRender() {},
        stage: { context: { glVersion }, filterManager: manager,
            pushRenderTargetConfig() { events.push('push'); }, popRenderTarget() { events.push('pop'); } },
    });
    if (fail) assert.throws(() => cache.render(), new RegExp(fail)); else cache.render();
    assert.deepEqual(released, allocated, 'all temporary images released');
    assert.equal(parent.view.target, savedTarget);
    assert.equal(parent.view.projection, savedProjection);
    assert.equal(events.at(-1), 'pop');
    if (!fail) assert.deepEqual(events, ['push', 'backdrop', 'reset', 'source', ...(filters ? ['filter'] : []), 'composite', 'pop']);
}
for (const version of [1, 2]) for (const filters of [false, true]) for (const failure of [null, 'source', 'backdrop']) check(version, filters, failure);

// ES5 compilation must preserve the receiver for the render-order getter.
const { _Render_MaterialBase: MaterialBase } = load('renderer/lib/base/_Render_MaterialBase.ts', {
    '@awayjs/core': { AbstractionBase: class {} },
});
const { _Render_RendererMaterial: Material } = load('renderer/lib/base/_Render_RendererMaterial.ts', {
    './_Render_MaterialPassBase': { _Render_MaterialPassBase: MaterialBase },
});
const m = Object.create(Material.prototype);
let renders = 0;
Object.assign(m, { _asset: { useNonNativeBlend: false }, _invalidRender: true, _invalidAnimation: false,
    _renderOrderId: 42, _pUpdateRender() { renders++; this._invalidRender = false; } });
assert.equal(m.renderOrderId, 42); assert.equal(renders, 1);
assert.equal(m.renderOrderId, 42); assert.equal(renders, 1);
m._asset.useNonNativeBlend = true;
assert.equal(m.renderOrderId, 42); assert.equal(m.renderOrderId, 42); assert.equal(renders, 3);
console.log('Passed: isolated overlay sources, filtered overlays, MSAA/non-MSAA, exception cleanup, ordinary caches and changing backdrops.');
