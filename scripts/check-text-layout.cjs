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
field.text = 'AA';
field.setTextFormat(format);
field.width = 100;
function geometry() {
    for (const textFormat of field._textFormats) textFormat.font_table = font;
    field.reConstruct(true);
    return Object.values(field.textShapes).flatMap(s => s.verts.flatMap(v => Array.from(v)));
}
const first = geometry();
assert.equal(first.length, 12, 'two triangle glyphs');
for (const width of [140, 180, 100, 100]) {
    field.width = width;
    const positions = geometry();
    assert.equal(positions.length, first.length, 'resizing must replace glyphs, not append');
    for (let i = 0; i < positions.length; i++) {
        assert.equal(positions[i], first[i] + (i % 2 === 0 ? (width - 100) / 2 : 0));
    }
}
field.text = 'A';
assert.equal(geometry().length, 6, 'removing characters discards old geometry');
field.text = '';
assert.equal(geometry().length, 0, 'clearing text discards all glyphs');
console.log('Passed: centered text reflows without duplicate glyphs, repeated widths, shrinking and clearing text.');
