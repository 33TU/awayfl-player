const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function load(file, imports) {
    const exports = {};
    new Function('require', 'exports', ts.transpileModule(fs.readFileSync(
        path.resolve(__dirname, file), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText)(id => imports[id] || {}, exports);
    return exports;
}
const { EventDispatcherBase } = load('../../playerglobal/lib/events/EventDispatcherBase.ts', {
    '@awayfl/avm2': { ASObject: class {} },
});
const dispatches = [];
class DisplayObject extends EventDispatcherBase {
    dispatchEvent(event, comesFromAway) {
        dispatches.push({ event, comesFromAway });
        return super.dispatchEvent(event);
    }
}
class InputEvent {
    constructor(type) { this.type = type; }
    fillFromAway(event) { this.target = event.target; }
}
const { InteractiveObject } = load('../../playerglobal/lib/display/InteractiveObject.ts', {
    './DisplayObject': { DisplayObject },
});
const target = Object.create(InteractiveObject.prototype);
target.sec = { flash: { events: { MouseEvent: InputEvent, TouchEvent: InputEvent, FocusEvent: InputEvent } } };
target.eventMappingInvert = { click: 'click', touchBegin: 'touchBegin', focusIn: 'focusIn' };
const reports = [], reportError = console.error;
console.error = (...args) => reports.push(args);
try {
    for (const [callback, type, error] of [
        ['mouseCallback', 'click', new TypeError('avatar.pMC is null')],
        ['touchCallback', 'touchBegin', { $Bgmessage: 'ActionScript touch error' }],
        ['focusCallback', 'focusIn', 'focus failure'],
    ]) {
        const fail = () => { throw error; };
        target.addEventListener(type, fail);
        let rendered = false;
        assert.doesNotThrow(() => {
            target[callback]({ type, target });
            rendered = true; // host frame can finish after delivering input
        });
        assert.equal(rendered, true);
        assert.equal(reports.at(-1)[2], error, 'keep original exception for diagnosis');
        assert.match(reports.at(-1)[0], new RegExp(type));
        assert.equal(dispatches.at(-1).comesFromAway, true);
        assert.equal(dispatches.at(-1).event.target, target);

        // Only the native boundary catches errors. Explicit AS dispatch still throws.
        assert.throws(() => target.dispatchEvent(new InputEvent(type)), e => e === error);
        target.removeEventListener(type, fail);
        let calls = 0;
        const healthy = () => calls++;
        target.addEventListener(type, healthy);
        target[callback]({ type, target });
        target[callback]({ type, target });
        assert.equal(calls, 2, 'later native input remains usable');
        target.removeEventListener(type, healthy);
    }
    assert.equal(reports.length, 3);

    // A script may catch an error from its own nested dispatch as before.
    const nestedError = new Error('nested dispatch');
    target.addEventListener('nested', () => { throw nestedError; });
    target.addEventListener('click', () => {
        assert.throws(() => target.dispatchEvent(new InputEvent('nested')), e => e === nestedError);
    });
    target.mouseCallback({ type: 'click', target });
    assert.equal(reports.length, 3, 'script-caught errors are not reported as uncaught');
} finally {
    console.error = reportError;
}
console.log('Passed: native mouse/touch/focus error recovery, diagnostics, subsequent input, and explicit dispatch exceptions.');
