const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
global.self = globalThis;
global.window = globalThis;
const core = require('@awayjs/core');
const scene = require('@awayjs/scene');
const { View } = require('@awayjs/view');
// No canvas or render pass: exercise the real scene graph and view nodes.
const view = new View(null, { width: 960, height: 500, addEventListener() {} });
class Point {
    constructor(x = 0, y = 0) { this.adaptee = x instanceof core.Point ? x : new core.Point(x, y); }
    get x() { return this.adaptee.x; }
    get y() { return this.adaptee.y; }
}
const imports = {
    '../events/EventDispatcher': { EventDispatcher: class {} },
    '../events/Event': {}, '../events/StaticEvents': {}, './LoaderInfo': {},
    './DisplayObjectContainer': {}, './Stage': {}, '@awayfl/avm2': {},
    '../geom/Transform': {}, '../geom/Rectangle': {}, '../geom/Point': {},
    '../geom/Vector3D': {}, '../SecurityDomain': {}, '../filters/FilterBuilder': {},
    '../filters/BitmapFilter': {},
    '@awayfl/swf-loader': { AVMStage: { instance: () => ({ view }) } },
};
const exports_ = {};
new Function('require', 'exports', ts.transpileModule(fs.readFileSync(
    path.resolve(__dirname, '../../playerglobal/lib/display/DisplayObject.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText)(id => {
    if (Object.hasOwn(imports, id)) return imports[id];
    if (id.startsWith('@awayjs/')) return require(id);
    throw new Error(`Unexpected import: ${id}`);
}, exports_);
const { DisplayObject } = exports_;
function adapt(container) {
    const object = Object.create(DisplayObject.prototype);
    object._adaptee = container;
    object.sec = { flash: { geom: { Point } } };
    return object;
}
function near(actual, expected, message) {
    assert.ok(Math.abs(actual - expected) < 0.001, `${message}: ${actual} != ${expected}`);
}
function check(avatar, body, expectedX, expectedY, precreateChild) {
    if (precreateChild) view.getNode(body);
    const a = adapt(avatar), b = adapt(body);
    const head = new Point(0, -138.5);
    // AQW calls the child's localToGlobal before the parent's globalToLocal.
    const worldPoint = b.localToGlobal(head);
    near(worldPoint.x, expectedX, 'child conversion includes ancestors before first render');
    near(worldPoint.y, expectedY, 'head global Y');
    const local = a.globalToLocal(worldPoint);
    near(local.y, -138.5 * body.scaleY + body.y, 'name remains above the avatar');
    return { a, b };
}
for (const precreateChild of [false, true]) {
    const avatar = new scene.Sprite(), body = new scene.Sprite();
    avatar.x = 440; avatar.y = 350;
    avatar.addChild(body);
    const { a, b } = check(avatar, body, 440, 211.5, precreateChild);
    const room = new scene.Sprite();
    room.x = 20; room.y = 65;
    room.addChild(avatar);
    near(b.localToGlobal(new Point()).y, 415, 'new offstage ancestor is included');
    const nextRoom = new scene.Sprite();
    nextRoom.x = -10; nextRoom.y = 120;
    nextRoom.addChild(avatar);
    near(b.localToGlobal(new Point()).y, 470, 'reparenting updates conversion');
    avatar.y = 415;
    body.scaleY = 0.75;
    near(a.globalToLocal(b.localToGlobal(new Point(0, -138.5))).y, -103.875, 'scaled name position survives movement');
    nextRoom.removeChild(avatar);
    near(b.localToGlobal(new Point()).y, 415, 'detaching retains the offstage hierarchy');
}
const root = new scene.Sprite(), child = new scene.Sprite();
root.x = 50; root.y = 70; root.rotationZ = 90; root.scaleX = -2; root.scaleY = 3;
child.x = 10; child.y = 20; root.addChild(child);
const c = adapt(child);
const worldPoint = c.localToGlobal(new Point(4, 5));
near(worldPoint.x, -25, 'nested rotation and scale X');
near(worldPoint.y, 42, 'nested rotation and reflection Y');
const local = c.globalToLocal(worldPoint);
near(local.x, 4, 'round trip X'); near(local.y, 5, 'round trip Y');
console.log('Passed: offstage child-first coordinates, precreated nodes, room reparenting, movement, scaling, rotation and round trips without rendering.');
