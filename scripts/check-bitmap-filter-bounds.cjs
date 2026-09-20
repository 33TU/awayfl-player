const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
global.self = globalThis;
global.window = globalThis;
const core = require('@awayjs/core');
const viewMocks = { PickGroup: { getInstance: () => ({
    getBoundsPicker: () => ({ _isInFrustumInternal: () => true }),
}) } };
const exports_ = {};
const source = path.resolve(__dirname, '../../renderer/lib/RendererBase.ts');
new Function('require', 'exports', ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText)(name => {
    if (name === '@awayjs/core') return core;
    if (name === '@awayjs/view') return viewMocks;
    // No GPU, material construction or traversal is needed to compute bounds.
    if (name.startsWith('./') || name.startsWith('@awayjs/')) return {};
    throw new Error(`Unexpected import: ${name}`);
}, exports_);
const { RendererBase } = exports_;
function makeRenderer(target, box) {
    const view = { target, width: 960, height: 500, projection: { scale: 2 } };
    const renderer = Object.create(RendererBase.prototype);
    Object.defineProperty(renderer, 'useNonNativeBlend', { value: false });
    renderer._asset = { container: {}, getRoot: () => ({ view }) };
    renderer._renderMatrix = new core.Matrix3D();
    renderer._bounds = new core.Box();
    renderer._paddedBounds = new core.Rectangle();
    renderer._boundsPicker = { getBoxBounds: () => box };
    renderer._parentNode = { getMatrix3D: () => new core.Matrix3D() };
    renderer.parentRenderer = {
        getPaddedBounds: () => new core.Rectangle(0, 0, 960, 500),
        getParentPosition: () => new core.Vector3D(),
    };
    renderer.stage = { pixelRatio: 1 };
    renderer.view = view;
    renderer._style = {};
    renderer._boundsDirty = true;
    return renderer;
}
function bounds(target, box) {
    const renderer = makeRenderer(target, box);
    renderer._updateBounds();
    const p = renderer._paddedBounds;
    return [p.x, p.y, p.width, p.height].map(value => value === 0 ? 0 : value);
}
// BitmapData.draw's matrix can translate negative local coordinates into view.
// Screen-origin clipping used to turn these into negative texture dimensions.
assert.deepEqual(bounds({}, new core.Box(-300, -400, 0, 100, 50, 0)), [-302, -402, 104, 54]);
assert.deepEqual(bounds({}, new core.Box(180, -400, 0, 408, 50, 0)), [178, -402, 412, 54]);
assert.deepEqual(bounds({}, new core.Box(900, 450, 0, 100, 100, 0)), [898, 448, 104, 104]);

// Preserve the existing screen optimization where coordinates do match.
assert.deepEqual(bounds(null, new core.Box(-10, -20, 0, 100, 100, 0)), [0, 0, 92, 82]);
assert.deepEqual(bounds(null, new core.Box(900, 450, 0, 100, 100, 0)), [898, 448, 62, 52]);
// Empty bounds, exact viewport edges, and fully offscreen caches are valid
// states during a timeline transition, not errors or negative texture sizes.
assert.deepEqual(bounds(null, null), [0, 0, 0, 0]);
assert.deepEqual(bounds(null, new core.Box(962, 10, 0, 30, 30, 0)), [0, 0, 0, 0]);
assert.deepEqual(bounds(null, new core.Box(-100, -100, 0, 10, 10, 0)), [0, 0, 0, 0]);
assert.deepEqual(bounds(null, new core.Box(1000, 600, 0, 10, 10, 0)), [0, 0, 0, 0]);
assert.deepEqual(bounds(null, new core.Box(0, 0, 0, Infinity, 10, 0)), [0, 0, 0, 0]);

// Exercise the actual cache's image allocation and render entry point without
// requiring a GPU. Reject invalid sizes just as a real render target would.
const allocations = [];
class TestImage {
    constructor(width, height) { this._setSize(width, height); }
    _setSize(width, height) {
        width = Math.round(width); height = Math.round(height); // Image2D's actual allocation rule
        assert.ok(width > 0 && height > 0);
        this.width = width; this.height = height;
        allocations.push([width, height]);
    }
}
const cacheExports = {};
new Function('require', 'exports', ts.transpileModule(fs.readFileSync(
    path.resolve(__dirname, '../../renderer/lib/CacheRenderer.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText)(name => {
    if (name === '@awayjs/core') return core;
    if (name === '@awayjs/stage') return { Image2D: TestImage, ImageSampler: class {}, Settings: {} };
    if (name === './RendererBase') return { RendererBase };
    if (name === './base/_Render_RenderableBase') return { _Render_RenderableBase: class {} };
    if (name === './DefaultRenderer') return { DefaultRenderer: { registerMaterial() {} } };
    if (name === './RenderGroup') return { RenderGroup: { getInstance: () => ({ registerMaterial() {} }) } };
    if (name === './base/RenderEntity') return { RenderEntity: { registerRenderable() {} } };
    return {};
}, cacheExports);
const cache = makeRenderer(null, null);
Object.setPrototypeOf(cache, cacheExports.CacheRenderer.prototype);
cache._updateBounds();
assert.equal(cache._style.image, undefined);
cache.render(); // must return before touching any render-target state
assert.equal(allocations.length, 0);

cache._boundsPicker.getBoxBounds = () => new core.Box(10, 10, 0, 30, 30, 0);
cache._boundsDirty = true;
assert.equal(cache.getPaddedBounds().width, 34);
const image = cache._style.image;
assert.deepEqual(allocations, [[34, 34]]);

cache._boundsPicker.getBoxBounds = () => null;
cache._boundsDirty = true;
cache.render();
assert.equal(cache.getPaddedBounds().width, 0);
assert.equal(cache._bounds.width, 0); // no stale bounds from the previous frame
assert.equal(cache._style.image, image);
assert.equal(allocations.length, 1); // never resize an existing image to zero

// A previously visible cache must not submit its stale texture for rendering.
const parent = makeRenderer(null, new core.Box(0, 0, 0, 960, 500, 0));
parent._traverserGroup = { getRenderer: () => cache };
assert.equal(parent.getTraverser({ renderToImage: true, getLocalNode: () => cache.node }), undefined);

cache._boundsPicker.getBoxBounds = () => new core.Box(10, 10, 0, 50, 50, 0);
cache._boundsDirty = true;
assert.equal(cache.getPaddedBounds().width, 54);
assert.equal(cache._style.image, image);
assert.deepEqual(allocations, [[34, 34], [54, 54]]);

let renders = 0;
let targetDepth = 0;
cache.stage.context = { glVersion: 1 };
cache.stage.pushRenderTargetConfig = () => { targetDepth++; };
cache.stage.popRenderTarget = () => { targetDepth--; };
cache._initRender = target => { assert.ok(target.width > 0 && target.height > 0); };
const originalRender = RendererBase.prototype.render;
try {
    RendererBase.prototype.render = () => { renders++; };
    cache.render();
    assert.equal(renders, 1); // visible again: caching resumes normally
    assert.equal(targetDepth, 0);
    cache._boundsPicker.getBoxBounds = () => null;
    cache._boundsDirty = true;
    cache.render();
    assert.equal(renders, 1);
    assert.equal(targetDepth, 0); // an empty cache never pushes a target
} finally {
    RendererBase.prototype.render = originalRender;
}
// Fractional parent positions during resizing can clip a cache to less than
// half a pixel. It must cover that strip, never allocate a 0xN/Nx0 texture.
for (const axis of ['x', 'y']) {
    cache.parentRenderer.getParentPosition = () => axis === 'x'
        ? new core.Vector3D(-0.8, 0) : new core.Vector3D(0, -0.8);
    cache._boundsPicker.getBoxBounds = () => axis === 'x'
        ? new core.Box(-12, 10, 0, 11, 30, 0)
        : new core.Box(10, -12, 0, 30, 11, 0);
    cache._boundsDirty = true;
    const pad = cache.getPaddedBounds();
    assert.deepEqual([pad.x, pad.y, pad.width, pad.height], axis === 'x'
        ? [0, 8, 1, 34] : [8, 0, 34, 1]);
    assert.equal(cache._style.image.width, pad.width);
    assert.equal(cache._style.image.height, pad.height);
}
console.log('Passed: offscreen bitmap bounds, viewport clipping, empty cache skipping, and empty-to-visible texture recovery.');

// Apply filters through the actual display-object setter after the cache has
// already been rendered. Padding must refresh without moving or changing text.
const displayExports = {};
new Function('require', 'exports', ts.transpileModule(fs.readFileSync(
    path.resolve(__dirname, '../../scene/lib/display/DisplayObject.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText)(name => {
    if (name === '@awayjs/core') return core;
    if (name === '../Settings') return { Settings: { USE_UNSAFE_FILTERS: true } };
    return {};
}, displayExports);
const display = Object.create(displayExports.DisplayObject.prototype);
cache._asset.container = display;
display._renderObjects = {};
display.invalidate = () => cache.onInvalidate();
cache.onInvalidate = RendererBase.prototype.onInvalidate;
cache.parentRenderer.getParentPosition = () => new core.Vector3D();
cache._boundsPicker.getBoxBounds = () => new core.Box(100, 100, 0, 30, 30, 0);
cache.stage.filterManager = { computeFiltersPadding(rect, filters) {
    const amount = filters[0].blurX;
    rect.x -= amount; rect.y -= amount; rect.width += amount * 2; rect.height += amount * 2;
} };
cache._boundsDirty = true;
assert.equal(cache.getPaddedBounds().width, 34);
for (const [filters, width] of [[[{ blurX: 3 }], 40], [[{ blurX: 20 }], 74], [[], 34]]) {
    display.filters = filters;
    assert.equal(cache.getPaddedBounds().width, width, 'filter-only changes must recompute cache padding');
    assert.equal(cache._style.image.width, width);
}
console.log('Passed: adding, widening, and removing filters refreshes existing cache bounds without text or transform changes.');
