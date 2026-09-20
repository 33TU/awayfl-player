const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(file, imports) {
    const source = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
    const exports = {};
    new Function('require', 'exports', ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText)(name => {
        if (Object.hasOwn(imports, name)) return imports[name];
        throw new Error(`Unexpected runtime import: ${name}`);
    }, exports);
    return exports;
}

const { FrameScriptManager } = load('../../scene/lib/managers/FrameScriptManager.ts', {});
const { MovieClip } = load('../../playerglobal/lib/display/MovieClip.ts', {
    '@awayjs/scene': { FrameScriptManager },
    './Sprite': { Sprite: class { get adaptee() { return this._adaptee; } } },
    '@awayjs/core': {},
    '@awayfl/avm2': {},
    '../events/Event': {},
    './FrameLabel': {},
});
function clip(callback) {
    const adapter = Object.create(MovieClip.prototype);
    adapter.sec = { swfVersion: 15 };
    adapter.constructorHasRun = true;
    adapter.allowScript = true;
    adapter._framescripts = [{ axCall: callback }];
    adapter._adaptee = { currentFrameIndex: 0, adapter };
    return adapter;
}
function queue(adapter) {
    FrameScriptManager.add_script_to_queue(adapter.adaptee, adapter._framescripts[0]);
}

const reports = [];
const originalError = console.error;
console.error = (...args) => reports.push(args);
try {
    // A failed parent callback must not discard a child's queued initialization.
    let initialized = false;
    const thrown = new TypeError('avatar is not initialized');
    const parent = clip(() => { throw thrown; });
    const child = clip(() => { initialized = true; });
    queue(parent);
    queue(child);
    assert.doesNotThrow(() => FrameScriptManager.execute_queue());
    assert.equal(initialized, true);
    assert.equal(MovieClip.current_script_scope, null);
    assert.equal(reports[0][2], thrown, 'retain the original error for diagnostics');
    assert.equal(reports.length, 1);
    parent.executeScript();
    assert.equal(reports.length, 1, 'do not rerun a failed callback on the same frame');

    // Nested gotoAndPlay callbacks must restore the caller and run pending navigation.
    const order = [];
    const inner = clip(() => {
        assert.equal(MovieClip.current_script_scope, inner);
        inner.queuedNavigationAction = () => {
            assert.equal(MovieClip.current_script_scope, outer);
            assert.equal(inner.queuedNavigationAction, null);
            order.push('navigation');
        };
        throw { $Bgmessage: 'ActionScript error' };
    });
    const outer = clip(() => {
        order.push('outer');
        inner.executeScript();
        assert.equal(MovieClip.current_script_scope, outer);
        order.push('continued');
    });
    outer.executeScript();
    assert.deepEqual(order, ['outer', 'navigation', 'continued']);
    assert.equal(MovieClip.current_script_scope, null);
    assert.equal(reports[1][1], 'ActionScript error');
    assert.equal(reports.length, 2);

    // Normal callbacks and navigation retain the same ordering.
    const healthy = clip(() => {
        order.push('healthy');
        healthy.queuedNavigationAction = () => order.push('healthy navigation');
    });
    healthy.executeScript();
    assert.deepEqual(order.slice(-2), ['healthy', 'healthy navigation']);
    assert.equal(MovieClip.current_script_scope, null);
} finally {
    console.error = originalError;
}
console.log('Passed: frame errors preserve queued initialization, nested callers, scope restoration, pending navigation, and diagnostics.');
