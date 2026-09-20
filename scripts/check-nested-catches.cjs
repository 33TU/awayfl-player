const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

// Compile real AVM2 bytecode with the local compiler, without starting a player.
process.env.NODE_PATH = [path.resolve(__dirname, '../node_modules'), process.env.NODE_PATH]
    .filter(Boolean).join(path.delimiter);
Module._initPaths();
global.self = globalThis;
global.window = globalThis;
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(
    fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText, filename);
const { compile } = require('../../avm2/lib/jit.ts');
const { Bytecode: B } = require('../../avm2/lib/Bytecode.ts');
const { COMPILER_DEFAULT_OPT } = require('../../avm2/lib/flags.ts');

function fixture(rethrow = false) {
    const bytes = [], labels = {}, jumps = [];
    const mark = name => { labels[name] = bytes.length; };
    const emit = (...values) => bytes.push(...values);
    const jump = (op, label) => {
        emit(op); jumps.push([bytes.length, label]); emit(0, 0, 0);
    };
    mark('outer');
    emit(B.PUSHBYTE, 0, B.SETLOCAL3);
    mark('inner');
    emit(B.GETLOCAL1);
    jump(B.IFFALSE, 'skip');
    emit(B.GETLOCAL2, B.THROW);
    // Splitting nested try blocks at this branch target must preserve handler order.
    mark('skip');
    mark('innerEnd');
    jump(B.JUMP, 'after');
    mark('innerHandler');
    if (rethrow) emit(B.THROW);
    else emit(B.POP, B.PUSHBYTE, 1, B.SETLOCAL3);
    jump(B.JUMP, 'after');
    mark('after');
    emit(B.GETLOCAL3);
    mark('outerEnd');
    emit(B.RETURNVALUE);
    mark('outerHandler');
    emit(B.POP, B.PUSHBYTE, 2, B.RETURNVALUE);
    for (const [offset, label] of jumps) {
        const delta = labels[label] - offset - 3;
        bytes.splice(offset, 3, delta & 255, (delta >> 8) & 255, (delta >> 16) & 255);
    }
    const type = { name: 'InnerError' };
    const body = {
        code: Uint8Array.from(bytes), maxStack: 1, localCount: 4,
        initScopeDepth: 0, maxScopeDepth: 0,
        catchBlocks: [
            { start: labels.inner, end: labels.innerEnd, target: labels.innerHandler, type },
            { start: labels.outer, end: labels.outerEnd, target: labels.outerHandler, type: null },
        ],
    };
    const method = {
        abc: {}, meta: { name: 'nestedCatch', filePath: 'regression/nestedCatch' },
        parameters: [1, 2].map(() => ({ typeName: null, hasOptionalValue: () => false })),
        needsRest: () => false, needsArguments: () => false, getBody: () => body,
    };
    const result = compile(method, { optimise: COMPILER_DEFAULT_OPT });
    assert.equal(result.error, null);
    return result.compiled({
        names: result.names, jsGlobal: globalThis,
        savedScope: { global: { object: {} } },
        sec: { application: { getClass: () => ({ axIsType: e => e.inner === true }) } },
    });
}
const run = fixture();
assert.equal(run(false, { inner: true }), 0, 'no exception continues normally');
assert.equal(run(true, { inner: true }), 1, 'inner handler wins and continues after optional failure');
assert.equal(run(true, { inner: false }), 2, 'unmatched inner error reaches outer handler');
assert.equal(fixture(true)(true, { inner: true }), 2, 'rethrow from inner handler reaches outer handler');
console.log('Passed: nested JIT handlers preserve priority across branch boundaries and rethrows.');
