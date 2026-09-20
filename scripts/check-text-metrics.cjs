const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

global.self = globalThis;
global.window = globalThis;
const scene = require('@awayjs/scene');
const sourceRoot = path.resolve(__dirname, '../../scene');
const cache = new Map();

// Use the source TextField and real engine geometry with a tiny embedded font.
function loadSource(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    });
    new Function('require', 'exports', outputText)(id => {
        if (!id.startsWith('.')) return require(id);
        const name = path.basename(id);
        if (Object.hasOwn(scene, name)) return { [name]: scene[name] };
        return loadSource(path.resolve(path.dirname(file), id + '.ts'));
    }, exports);
    return exports;
}
const { TextField } = loadSource(path.join(sourceRoot, 'lib/display/TextField.ts'));

const { Float2Attributes } = require('@awayjs/stage');
const { MaterialManager, GraphicsPath } = require('@awayjs/graphics');
const { MethodMaterial } = require('@awayjs/materials');
MaterialManager.getMaterialForColor = () => new MethodMaterial(0xffffff);
const font = new scene.TesselatedFontTable();
font.ascent = 24;
font.descent = -8;
const triangle = new Float2Attributes();
triangle.set(new Float32Array([0, 0, 8, 0, 0, 12]));
font.setChar('65', 10, triangle.attributesBuffer, null, false, 0, new GraphicsPath());
font.getChar('65', false).lastTesselatedScale = 1;
const format = new scene.TextFormat();
format.size = 32;
format.align = 'center';
format.font_table = font;
const field = new TextField();
format.align = 'left';
field.width = 100;
field.multiline = true;
field.setTextFormat(format);

function text(value) {
    field.text = value;
    field.setTextFormat(format);
    for (const f of field._textFormats) f.font_table = font;
}
text('AA');
let first = field.getCharBoundaries(0);
assert.ok(first && first.width === 10 && first.height > 10);
assert.equal(field.getCharBoundaries(1).x, first.x + 10);
assert.equal(field.getCharBoundaries(-1), null);
assert.equal(field.getCharBoundaries(2), null);
assert.equal(field.getLineIndexOfChar(-1), -1);
assert.equal(field.getLineIndexOfChar(2), -1);

// Layout queries must rebuild immediately, including width-only changes.
format.align = 'center';
field.setTextFormat(format);
for (const f of field._textFormats) f.font_table = font;
first = field.getCharBoundaries(0);
field.width = 140;
assert.equal(field.getCharBoundaries(0).x, first.x + 20);
assert.equal(field.char_positions_x.length, 2);
field.width = 100;
assert.equal(field.getCharBoundaries(0).x, first.x);

text('AA\n\nAA');
assert.equal(field.getLineIndexOfChar(0), 0);
assert.equal(field.getLineIndexOfChar(2), 0); // newline belongs to preceding line
assert.equal(field.getLineIndexOfChar(3), 1);
assert.equal(field.getLineIndexOfChar(4), 2);
assert.deepEqual([0, 1, 2].map(i => field.getLineOffset(i)), [0, 3, 4]);
assert.equal(field.getCharBoundaries(2), null);
assert.equal(field.getCharBoundaries(3), null);
assert.ok(field.getCharBoundaries(4).y > field.getCharBoundaries(0).y);
assert.equal(field.getCharBoundaries(6), null);

format.align = 'left';
field.width = 25;
field.wordWrap = true;
text('AAAAAA');
assert.equal(field.getLineIndexOfChar(0), 0);
assert.ok(field.getLineIndexOfChar(5) > 0);
const lastLine = field.getLineIndexOfChar(5);
assert.ok(field.getLineOffset(lastLine) > 0);
assert.ok(field.getCharBoundaries(5).y > field.getCharBoundaries(0).y);

// Verify the Flash adapter wraps the engine rectangle instead of returning null.
const flashExports = {};
class FlashRectangle {
    constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); }
}
new Function('require', 'exports', ts.transpileModule(fs.readFileSync(
    path.resolve(__dirname, '../../playerglobal/lib/text/TextField.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText)(id => {
    if (id === '../display/InteractiveObject') return { InteractiveObject: class {} };
    if (id === '@awayjs/scene') return scene;
    if (id === '@awayjs/core') return require(id);
    return {};
}, flashExports);
const adapter = Object.create(flashExports.TextField.prototype);
adapter._adaptee = field;
adapter.sec = { flash: { geom: { Rectangle: FlashRectangle } } };
assert.ok(adapter.getCharBoundaries(0) instanceof FlashRectangle);
assert.equal(adapter.getCharBoundaries(-1), null);
assert.equal(adapter.getCharBoundaries(99), null);
text('');
assert.equal(adapter.getCharBoundaries(0), null);
assert.equal(field.getLineIndexOfChar(0), -1);
console.log('Passed: Flash character rectangles, immediate layout, resizing, wrapping, explicit/empty lines, and invalid indices.');
