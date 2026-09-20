const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
global.self = globalThis;
global.window = globalThis;
const core = require('@awayjs/core');
const exports_ = {};
const source = path.resolve(__dirname, '../../renderer/lib/RendererBase.ts');
new Function('require', 'exports', ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText)(name => {
    if (name === '@awayjs/core') return core;
    // No GPU, material construction or traversal is needed to compute bounds.
    if (name.startsWith('./') || name.startsWith('@awayjs/')) return {};
    throw new Error(`Unexpected import: ${name}`);
}, exports_);
const { RendererBase } = exports_;
function bounds(target, box) {
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
console.log('Passed: bitmap filter bounds retain negative local origins with positive dimensions; on-screen clipping is preserved.');
