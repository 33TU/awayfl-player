const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const listeners = new Map();
global.document = {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
};
let focus = null;
const mouseManager = { allowKeyInput: true, getFocus: () => focus, setFocus: value => { focus = value; } };
const avmStage = { isPaused: false, mouseManager };
class KeyboardEvent {
    static KEY_DOWN = 'keyDown'; static KEY_UP = 'keyUp';
    constructor(type, bubbles, cancelable, charCode, keyCode, location, ctrlKey, altKey, shiftKey) {
        Object.assign(this, { type, bubbles, cancelable, charCode, keyCode, location, ctrlKey, altKey, shiftKey });
    }
}
class DisplayObject {
    get adaptee() { return this._adaptee; }
    get activeStage() { return stage; }
    get stage() { return this === stage ? this : this.parent?.stage; }
    dispatchEvent(event) {
        received.push({ object: this.name, target: event.target?.name, type: event.type, code: event.keyCode });
        if (event.bubbles && this.parent) this.parent.dispatchEvent(event);
    }
}
const received = [];
const exports_ = {};
new Function('require', 'exports', ts.transpileModule(fs.readFileSync(
    path.resolve(__dirname, '../../playerglobal/lib/display/InteractiveObject.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText)(id => {
    if (id === './DisplayObject') return { DisplayObject };
    if (id === '../events/KeyboardEvent') return { KeyboardEvent };
    if (id === '@awayfl/swf-loader') return { AVMStage: { instance: () => avmStage } };
    return {};
}, exports_);
const { InteractiveObject } = exports_;
function object(name, parent) {
    const o = Object.create(InteractiveObject.prototype);
    Object.assign(o, { name, parent, _adaptee: {}, sec: { flash: { events: { KeyboardEvent } } } });
    return o;
}
const stage = object('stage');
const game = object('game', stage), chat = object('chat', game), login = object('login');
const unrelated = object('search', game);
for (const o of [login, stage, unrelated, chat]) {
    o.down = e => o.keyDownCallback(e);
    o.up = e => o.keyUpCallback(e);
    o.initKeyDownListener('', o.down, o.down);
    o.initKeyUpListener('', o.up, o.up);
}
assert.equal(listeners.has('keypress'), false, 'keypress must not duplicate keyDown or keyUp');
function key(type) {
    const event = { keyCode: 13, charCode: 0, location: 0, preventDefault() {} };
    for (const listener of listeners.get(type)) listener(event);
}
focus = { container: { adapter: chat } };
key('keydown'); key('keyup');
assert.deepEqual(received.map(e => [e.object, e.target, e.type]), [
    ['chat', 'chat', 'keyDown'], ['game', 'chat', 'keyDown'], ['stage', 'chat', 'keyDown'],
    ['chat', 'chat', 'keyUp'], ['game', 'chat', 'keyUp'], ['stage', 'chat', 'keyUp'],
]);
assert.ok(received.every(e => e.code === 13));
received.length = 0;
chat.parent = null;
key('keydown');
assert.equal(focus, null, 'removed fields lose stale scene focus before text editing');
assert.deepEqual(received.map(e => e.object), ['stage']);
received.length = 0;
avmStage.isPaused = true; key('keydown'); assert.equal(received.length, 0);
avmStage.isPaused = false;
mouseManager.allowKeyInput = false; key('keyup'); assert.equal(received.length, 0);
mouseManager.allowKeyInput = true;
for (const o of [login, stage, unrelated, chat]) {
    o.removeKeyDownListener('', o.down, o.down);
    o.removeKeyUpListener('', o.up, o.up);
}
assert.equal(listeners.get('keydown').size, 0);
assert.equal(listeners.get('keyup').size, 0);
console.log('Passed: focused keyboard target, single bubbling dispatch, unrelated/detached fields, keypress deduplication, pause and listener removal.');
