const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

global.self = globalThis;
global.window = globalThis;
const scene = require('@awayjs/scene');
const sourceRoot = path.resolve(__dirname, '../../scene');
const cache = new Map();

// Exercise the modified TextField with the installed engine helpers. No canvas
// is needed: the font below supplies distinct widths for '*' and normal glyphs.
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
const format = {
    font_table: { initFontSize() {}, getCharWidth(code) { return code === '42' ? 5 : 10; } },
    size: 12, indent: 0, leftMargin: 0, rightMargin: 0, letterSpacing: 0, leading: 0,
};
function layout(field) {
    field._textFormats = field._textFormatsIdx.map(() => format);
    field.buildParagraphs();
    field._textDirty = false;
}
function assertMasked(field, value) {
    layout(field);
    assert.equal(field.text, value, 'masking must preserve the input value');
    assert.deepEqual(field.chars_codes, Array(value.length).fill(42));
    assert.deepEqual(field.chars_width, Array(value.length).fill(5));
}
const field = new TextField();
assert.equal(field.displayAsPassword, false);
field.text = 'MaskTest7';
layout(field);
assert.deepEqual(field.chars_codes, Array.from(field.text, c => c.charCodeAt(0)));
field.displayAsPassword = true;
assert.equal(field._textDirty, true, 'toggling must invalidate existing layout');
assertMasked(field, 'MaskTest7');
field.displayAsPassword = false;
assert.equal(field._textDirty, true);
layout(field);
assert.deepEqual(field.chars_codes, Array.from(field.text, c => c.charCodeAt(0)));

field.displayAsPassword = true;
field._selectionBeginIndex = 4;
field._selectionEndIndex = 8;
field._insertNewText('AB');
assertMasked(field, 'MaskAB7');
field.text = 'a b\tc\nd\u{1F600}';
assertMasked(field, 'a b\tc\nd\u{1F600}');
field.text = '';
assertMasked(field, '');

field.text = 'CloneTest';
const clone = field.clone();
assert.equal(clone.displayAsPassword, true);
assertMasked(clone, 'CloneTest');
const plain = new TextField();
plain.text = 'Username';
plain.copyTo(clone);
assert.equal(clone.displayAsPassword, false, 'copying a plain field resets masking');
layout(clone);
assert.deepEqual(clone.chars_codes, Array.from('Username', c => c.charCodeAt(0)));
field.htmlText = '<b>Hidden</b>';
assertMasked(field, 'Hidden');
console.log('Passed: password glyphs/widths, original values, toggles, selection editing, whitespace/UTF-16, empty text, cloning and HTML.');
