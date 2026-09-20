const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
global.self = globalThis;
global.window = globalThis;
const scene = require('@awayjs/scene');
function load(file, imports) {
    const exports = {};
    const source = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
    new Function('require', 'exports', ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText)(id => {
        if (Object.hasOwn(imports, id)) return imports[id];
        if (id.startsWith('@awayjs/')) return require(id);
        throw new Error(`Unexpected dependency: ${id}`);
    }, exports);
    return exports;
}
const tags = load('../../swf-loader/lib/factories/base/SWFTags.ts', { './utilities/Debug': {} });
const { SymbolDecoder } = load('../../swf-loader/lib/parsers/SymbolDecoder.ts', {
    '../factories/base/SWFTags': tags,
    './ISymbol': {},
    '../factories/timelinesounds/MovieClipSoundsManager': {},
    './SWFFrame': {}, './SWFParser': {},
});
const { DefaultFontManager, TesselatedFontTable, TextField } = scene;
const family = 'Duplicate embedded family';
const namespace = 'name-label.swf';
function makeFont(key, ns, codes, style = 'standart') {
    const font = DefaultFontManager.defineFont(key, ns);
    font.name = family;
    const table = font.create_font_table(style, TesselatedFontTable.assetType);
    table.ascent = 24;
    table.descent = -8;
    const { GraphicsPath } = require('@awayjs/graphics');
    for (const code of codes) table.setChar(String(code), 10, null, null, false, 0, new GraphicsPath());
    return { font, table };
}
// Register a different movie first to catch accidental global font lookups.
const foreign = makeFont(family, 'other.swf', [90]);
const full = makeFont(family, namespace, [65, 57]);
const subset = makeFont(family + '-2', namespace, [57]);
const bold = full.font.create_font_table('bold', TesselatedFontTable.assetType);
const boldSubset = makeFont(family + '-3', namespace, [57], 'bold');
const factory = {
    awaySymbols: {
        2: { name: family, away: subset.font, fontStyleName: 'standart' },
        3: { name: family, away: boldSubset.font, fontStyleName: 'bold' },
    },
    createTextField() { return new TextField(); },
};
const decoder = new SymbolDecoder({ fileName: namespace, factory });
decoder.reqursive = false;
const { TextFlags } = tags;
function editText(id = 2, embedded = true) {
    return decoder._createText({
        id: 10,
        fillBounds: { xMin: 0, xMax: 4000, yMin: 0, yMax: 400 },
        tag: {
            fontId: id, fontHeight: 640, initialText: '9999',
            flags: TextFlags.ReadOnly | (embedded ? TextFlags.UseOutlines : 0),
            align: 2, leftMargin: 0, rightMargin: 0, letterSpacing: 0, leading: 0,
        },
    });
}
const field = editText();
assert.equal(field.newTextFormat.font_table, full.table, 'dynamic text resolves the first family/style in its own movie');
assert.notEqual(field.newTextFormat.font_table, foreign.table);
field.text = 'AAA';
field.reConstruct(false);
assert.ok(field.textWidth > 0, 'letters absent from the placeholder subset must have widths');
assert.deepEqual(field.chars_width, [10, 10, 10]);
assert.equal(field.clone().newTextFormat.font_table, full.table, 'cloning preserves the resolved family');
assert.equal(editText(3).newTextFormat.font_table, bold, 'style is part of the lookup');
assert.equal(editText(2, false).newTextFormat.font_table, subset.table, 'non-embedded path is unchanged');
const label = {
    id: 20, tag: {}, matrix: null,
    fillBounds: { xMin: 0, xMax: 400, yMin: 0, yMax: 400 },
    records: [{ fontId: 2, fontHeight: 640, entries: [] }],
};
decoder._createLabel(label);
assert.equal(label.records[0].font_table, subset.table, 'static glyph indices keep their exact font definition');
console.log('Passed: duplicate embedded font subsets, runtime letters, movie isolation, bold style, cloning, static glyph IDs and non-embedded text.');
