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
    render() { this._invalid = false; this.events.push('source'); if (this.fail === 'source') throw Error('source'); }
}
const { CacheRenderer } = load('renderer/lib/CacheRenderer.ts', {
    '@awayjs/core': core, '@awayjs/stage': { Settings: { ENABLE_MULTISAMPLE_TEXTURE: true },
        Image2D: class { constructor(w, h) { this._setSize(w, h); } _setSize(w, h) { this.width = w; this.height = h; this.rect = new core.Rectangle(0, 0, w, h); } },
    },
    './RendererBase': { RendererBase }, './base/_Render_RenderableBase': { _Render_RenderableBase: class {} },
    './DefaultRenderer': { DefaultRenderer: { registerMaterial() {} } },
    './RenderGroup': { RenderGroup: { getInstance: () => ({ registerMaterial() {} }) } },
    './base/RenderEntity': { RenderEntity: { registerRenderable() {} } },
});
function check(glVersion, filters, fail, masked = false) {
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
        _parentNode: { getMaskOwners: () => masked ? [{}] : null },
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
    if (!fail) assert.deepEqual(events, ['push', 'backdrop', ...(masked ? [] : ['reset']), 'source', ...(filters ? ['filter'] : []), 'composite', 'pop']);
}
for (const version of [1, 2]) for (const filters of [false, true])
    for (const failure of [null, 'source', 'backdrop']) for (const masked of [false, true])
        check(version, filters, failure, masked);

// A static source can be reused, but its backdrop/composite must refresh.
{
    const target = { width: 8, height: 8, rect: new core.Rectangle(0, 0, 8, 8) };
    const parentBounds = new core.Rectangle(10, 20, 100, 100);
    const bounds = new core.Rectangle(30, 50, 8, 8);
    const backdrop = {}, events = [];
    let captures = 0, composites = 0, rasterCopies = 0;
    const cache = Object.assign(Object.create(CacheRenderer.prototype), {
        _style: { image: target }, useNonNativeBlend: true, useCroppedBlend: true,
        node: { container: { blendMode: 'overlay' } }, events, _invalid: true,
        parentRenderer: { flushBlendBackdrop() { captures++; return backdrop; }, getPaddedBounds: () => parentBounds },
        getPaddedBounds: () => bounds, _initRender() {},
        stage: { context: { glVersion: 1 }, pushRenderTargetConfig() {}, popRenderTarget() {}, filterManager: {
            popTemp() { return { ...target }; }, pushTemp() {},
            copyPixels(src, dst, rect, point, merge, mode) {
                if (src === backdrop) assert.deepEqual([rect.x, rect.y, rect.width, rect.height], [20, 30, 8, 8]);
                else if (mode) composites++;
                else rasterCopies++;
            },
        } },
    });
    cache.render(); cache.render();
    assert.equal(captures, 2); assert.equal(composites, 2);
    assert.equal(rasterCopies, 1); assert.deepEqual(events, ['source']);
    cache._invalid = true; // content/transform/filter invalidation
    cache.render();
    assert.equal(rasterCopies, 2); assert.deepEqual(events, ['source', 'source']);
}
const { RendererBase: ActualRenderer } = load('renderer/lib/RendererBase.ts', {
    '@awayjs/core': core, '@awayjs/stage': { Settings: { ENABLE_MULTISAMPLE_TEXTURE: true } },
});
for (const glVersion of [1, 2]) for (const failure of [false, true]) {
    const cacheImage = {}, msaaImage = {}, cache = { style: { image: cacheImage } };
    const quad = { renderable: cache }, sibling = {}, opaque = {};
    const projection = {}, target = {}, passes = [];
    const r = Object.assign(Object.create(ActualRenderer.prototype), {
        _blendAccumulator: cache, _disableClear: false,
        _paddedBounds: new core.Rectangle(10, 20, 100, 100),
        getBlendBatchBounds: () => new core.Rectangle(30, 40, 8, 8),
        _blendedRenderables: [quad, sibling], _opaqueRenderables: [opaque],
        view: { projection, target }, stage: { context: { glVersion }, filterManager: { popTemp: () => msaaImage, pushTemp() {}, copyPixels(src, dst, rect, point) { assert.equal(src, msaaImage); assert.equal(dst, cacheImage); assert.deepEqual([rect.width, rect.height, point.x, point.y], [8, 8, 20, 20]); } } },
        _initRender(image) { this.view.target = image; },
        executeRender() {
            passes.push({ blended: [...this._blendedRenderables], opaque: [...this._opaqueRenderables], clear: !this._disableClear });
            if (failure) throw Error('capture failure');
            assert.ok(this.view.target !== cacheImage || !this._blendedRenderables.includes(quad), 'no texture feedback');
        },
    });
    if (failure) {
        assert.throws(() => r.flushBlendBackdrop(), /capture failure/);
        assert.deepEqual(r._blendedRenderables, [quad, sibling]);
        assert.deepEqual(r._opaqueRenderables, [opaque]);
    } else {
        assert.equal(r.flushBlendBackdrop(), cacheImage);
        assert.deepEqual(passes.at(-1), { blended: [sibling], opaque: [opaque], clear: false });
        if (glVersion === 2) assert.deepEqual(passes[0], { blended: [quad], opaque: [], clear: true });
        assert.deepEqual(r._blendedRenderables, [quad]);
        r._blendedRenderables.push(sibling);
        passes.length = 0;
        r.flushBlendBackdrop();
        assert.equal(passes.length, glVersion === 2 ? 2 : 1, 'only seed the changed region and draw new siblings');
    }
    assert.equal(r.view.projection, projection); assert.equal(r.view.target, target); assert.equal(r._disableClear, false);
}

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
