const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file, imports) {
    const exports = {};
    new Function('require', 'exports', ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText)(id => imports[id] || {}, exports);
    return exports;
}
const root = path.resolve(__dirname, '../..');
const { LoaderInfoCompleteQueue: queue } = load(path.join(root, 'playerglobal/lib/display/LoaderInfo.ts'), {
    '../events/EventDispatcher': { EventDispatcher: class {} },
    '../events/Event': { Event: { COMPLETE: 'complete' } },
});
const calls = [], errors = [];
function completion(name, action = () => {}) {
    return { sec: { flash: { events: { Event: class { constructor(type) { this.type = type; } } } } },
        dispatchEvent(event) { assert.equal(event.type, 'complete'); calls.push(name); action(); } };
}
const frames = [];
global.window = { requestAnimationFrame: fn => frames.push(fn) };
let clock = 0;
const { RequestAnimationFrame } = load(require.resolve('@awayjs/core/lib/utils/RequestAnimationFrame.ts'), {
    './getTimer': { getTimer: () => clock += 16 },
});
const originalError = console.error;
console.error = (...args) => errors.push(args);
try {
    queue.addQueue(completion('next'));
    queue.addQueue(completion('throwing', () => {
        queue.addQueue(completion('queued during callback'));
        throw new Error('synthetic hair-load callback failure');
    }));
    let ticks = 0;
    const timer = new RequestAnimationFrame(() => { queue.executeQueue(); ticks++; }, null);
    timer.start();
    for (let i = 0; i < 6; i++) {
        assert.equal(frames.length, 1, 'a failing callback must not kill the frame scheduler');
        frames.shift()();
    }
    timer.stop();
    assert.equal(ticks, 6);
    assert.deepEqual(calls, ['throwing', 'next', 'queued during callback']);
    assert.equal(errors.length, 1);
    assert.equal(queue._queue.length, 0);
} finally { console.error = originalError; }
console.log('Passed: completion errors remain reported; later callbacks, newly queued loads, and subsequent animation frames continue.');

// Exercise actual WebGL binding code with a driver that optimizes out an input
// and maps another AGAL input to a different WebGL attribute location.
const { ContextWebGL } = load(path.join(root, 'stage/lib/webgl/ContextWebGL.ts'), {
    './ConstantsWebGL': { VERTEX_BUF_PROPS: { 4: { size: 4, type: 5126, normalized: false } } },
});
const context = Object.create(ContextWebGL.prototype);
const glCalls = [];
context._gl = {
    ARRAY_BUFFER: 34962,
    bindBuffer: (...args) => glCalls.push(['bind', ...args]),
    enableVertexAttribArray: n => { assert.ok(n >= 0); glCalls.push(['enable', n]); },
    vertexAttribPointer: (...args) => glCalls.push(['pointer', ...args]),
    disableVertexAttribArray: n => glCalls.push(['disable', n]),
};
context.assertLost = () => {};
context._currentProgram = { getAttribLocation: index => index === 7 ? 2 : -1 };
const buffer = { glBuffer: {}, dataPerVertex: 16 };
context.setVertexBufferAt(3, buffer);
context.setVertexBufferAt(3, null);
assert.equal(glCalls.length, 0);
context.setVertexBufferAt(7, buffer);
assert.deepEqual(glCalls.map(c => c[0]), ['bind', 'enable', 'pointer']);
assert.equal(glCalls[1][1], 2);
assert.equal(glCalls[2][1], 2);
context.setVertexBufferAt(7, null);
assert.deepEqual(glCalls.at(-1), ['disable', 2]);
context._currentProgram = null;
context.setVertexBufferAt(0, buffer);
assert.equal(glCalls.length, 4);
console.log('Passed: inactive shader inputs are skipped; mapped attribute locations are used for binding and disabling.');
