const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const exports_ = {};
let clock = 0;
const stat = { rec() { return this; }, begin() {}, end() {} };
new Function('require', 'exports', 'performance', ts.transpileModule(fs.readFileSync(
    path.resolve(__dirname, '../../swf-loader/lib/parsers/SWFParser.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText)(id => {
    if (id === '@awayjs/core') return { ParserBase: class {} };
    if (id === '../stat/Stat') return { Stat: stat };
    if (id === './ISymbol') return { SYMBOL_TYPE: { FONT: 'font' } };
    return {};
}, exports_, { now: () => clock });
const { SWFParser } = exports_;
function parser(fail = false) {
    const p = Object.create(SWFParser.prototype);
    p.dictionary = [];
    for (const id of [1, 3, 4, 8]) p.dictionary[id] = { id, type: id === 3 ? 'font' : 'shape', name: 'TestFont' };
    p.symbolClassesMap = [];
    p._swfFile = { frames: [], sceneAndFrameLabelData: { scenes: ['test'] } };
    p.decoded = []; p.finalized = []; p.finished = 0; p.errors = [];
    p.getSymbol = id => p.dictionary[id];
    p._symbolDecoder = {
        reqursive: true,
        createAwaySymbol(symbol) {
            assert.equal(p._lockFinalize, true);
            assert.equal(this.reqursive, false);
            p.decoded.push(symbol.id);
            clock += 9; // each simulated decode exceeds the batch time budget
            if (fail && symbol.id === 4) throw new Error('bad symbol');
            const asset = { id: symbol.id };
            symbol.away = asset;
            return asset;
        },
        framesToTimeline() { assert.deepEqual(p.decoded, [1, 3, 4, 8]); return { id: 'root' }; },
    };
    p.finalizeAsset = (asset, name) => p.finalized.push({ asset, name });
    p.finishParsing = () => { p.finished++; };
    p.dieWithError = e => p.errors.push(e);
    return p;
}
async function waitUntil(done) {
    for (let i = 0; i < 100; i++) {
        if (done()) return;
        await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.fail('symbol decode did not finish');
}
(async () => {
    const p = parser();
    let heartbeats = 0;
    const timer = setInterval(() => heartbeats++, 0);
    try {
        p.finishSymbols();
        assert.equal(p.finished, 0, 'must not complete while decoding is suspended');
        assert.equal(p.finalized.length, 0, 'do not expose a partially decoded asset graph');
        // A ParserBase frame during the await must not restart the decoder.
        p.proceedParsing();
        await waitUntil(() => p.finished);
        assert.ok(heartbeats >= 2, 'other tasks run between symbol batches');
        assert.deepEqual(p.decoded, [1, 3, 4, 8]);
        assert.equal(p.finished, 1);
        assert.equal(p.finalized.length, 5);
        assert.equal(p.finalized.at(-1).name, 'scene');
        assert.deepEqual(p.finalized.at(-1).asset.scenes, ['test']);
        assert.equal(p._lockFinalize, false);
        assert.equal(p._symbolDecoder.reqursive, true);
        const failed = parser(true);
        failed.finishSymbols();
        await waitUntil(() => failed.errors.length);
        assert.equal(failed.finished, 0);
        assert.equal(failed.finalized.length, 0);
        assert.match(failed.errors[0], /bad symbol/);
        assert.equal(failed._lockFinalize, false);
        assert.equal(failed._symbolDecoder.reqursive, true);
    } finally { clearInterval(timer); }
    console.log('Passed: symbol decoding yields, preserves dependency order, finalizes once after decoding, and restores state on failure.');
})().catch(error => { console.error(error); process.exitCode = 1; });
