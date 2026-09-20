const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

global.self = globalThis;
global.window = globalThis;
const engine = require('@awayjs/graphics');
const core = require('@awayjs/core');

// Load the actual adapter with lightweight AS3 constructor/Vector stand-ins.
// Keep the real installed engine data classes, which need no display or WebGL.
const classes = {};
for (const name of ['GraphicsSolidFill', 'GraphicsEndFill', 'GraphicsStroke',
    'GraphicsPath', 'GraphicsGradientFill', 'GraphicsBitmapFill', 'GraphicsTrianglePath', 'BitmapData']) {
    classes[name] = class { constructor(...args) { this.args = args; } };
}
function loadAdapter(source) {
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    });
    const exports = {};
    new Function('require', 'exports', outputText)(name => {
        if (name === '@awayjs/graphics') return engine;
        if (name === '@awayjs/core') return core;
        if (name === '@awayfl/avm2') return { ASObject: class {} };
        if (name.startsWith('./') && Object.hasOwn(classes, name.slice(2))) {
            return { [name.slice(2)]: classes[name.slice(2)] };
        }
        throw new Error(`Unexpected runtime import: ${name}`);
    }, exports);
    const adapter = Object.create(exports.Graphics.prototype);
    adapter.sec = { flash: { display: classes } };
    adapter._toInt32Vector = values => values.slice();
    adapter._toFloat64Vector = values => values.slice();
    return adapter;
}
const source = fs.readFileSync(path.resolve(__dirname, '../../playerglobal/lib/display/Graphics.ts'), 'utf8');
const adapter = loadAdapter(source);
const convert = item => adapter._engineItemToAS3(item, new core.Matrix());
const fill = new engine.SolidFillStyle(0x123456, 0.5);
const stroke = convert(new engine.GraphicsStrokeStyle(fill, 7));
assert.ok(stroke instanceof classes.GraphicsStroke);
assert.equal(stroke.args[0], 7);
assert.ok(stroke.args[6] instanceof classes.GraphicsSolidFill);
assert.deepEqual(stroke.args[6].args, [0x123456, 0.5]);

const commands = [1, 2], data = [10, 20, 30, 40];
const convertedPath = convert(new engine.GraphicsPath(commands, data, 'evenOdd'));
assert.ok(convertedPath instanceof classes.GraphicsPath);
assert.deepEqual(convertedPath.commands, commands);
assert.deepEqual(convertedPath.data, data);
assert.equal(convertedPath.winding, 'evenOdd');
assert.ok(convert({ data_type: '[graphicsdata EndFill]' }) instanceof classes.GraphicsEndFill);
assert.equal(convert({ data_type: '[graphicsdata unknown]' }), null);
assert.equal(convert(null), null);
console.log('Passed: graphics strokes, paths, end-fill tags, and unknown records work without an engine GraphicsEndFill export.');
