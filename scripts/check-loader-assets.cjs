const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file, imports) {
    const exports = {};
    new Function('require', 'exports', ts.transpileModule(
        fs.readFileSync(path.resolve(__dirname, file), 'utf8'), {
            compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
        }).outputText)(name => {
        if (Object.hasOwn(imports, name)) return imports[name];
        throw new Error(`Unexpected import: ${name}`);
    }, exports);
    return exports;
}
class DisplayObject {
    constructor() { this._containerNodes = {}; this.events = []; this.adapter = {}; }
    isOnDisplayList() { return false; }
    _setParent(parent) { this.parent = parent; }
    advanceFrame() { this.frames = (this.frames || 0) + 1; }
    addEventListener() {}
    dispatchEvent(event) { this.events.push(event); }
}
const core = {
    ArgumentError: Error, RangeError,
    AssetEvent: { ASSET_COMPLETE: 'assetComplete' },
    URLLoaderEvent: { LOAD_ERROR: 'loadError' },
    ParserEvent: { PARSE_ERROR: 'parseError' },
};
const { DisplayObjectContainer } = load('../../scene/lib/display/DisplayObjectContainer.ts', {
    '@awayjs/core': core, '@awayjs/view': {}, './DisplayObject': { DisplayObject },
});
const { LoaderContainer } = load('../../scene/lib/display/LoaderContainer.ts', {
    '@awayjs/core': core, './DisplayObjectContainer': { DisplayObjectContainer },
});
class FlashContainer {
    get adaptee() { return this._adaptee; }
}
class Factory { constructor() { this.awaySymbols = {}; } }
class Parser { constructor(factory) { this.factory = factory; } }
const { Loader } = load('../../playerglobal/lib/display/Loader.ts', {
    '@awayjs/core': core, '@awayjs/stage': { Image2DParser: Parser },
    '@awayjs/graphics': {}, '@awayjs/scene': { LoaderContainer },
    '@awayfl/swf-loader': { SWFParser: Parser, matchRedirect: () => null },
    '@awayfl/avm2': {}, '../events/UncaughtErrorEvents': {},
    '../factories/FlashSceneGraphFactory': { FlashSceneGraphFactory: Factory },
    '../system/LoaderContext': { LoaderContext: class {} },
    '../system/ApplicationDomain': { ApplicationDomain: {} },
    './DisplayObjectContainer': { DisplayObjectContainer: FlashContainer },
});
const adapter = Object.create(Loader.prototype);
adapter.sec = {};
adapter._contentLoaderInfo = { _setApplicationDomain() {} };
adapter._adaptee = adapter.createAdaptee();
const container = adapter.adaptee;
let disposed = 0;
container._disposeLoader = () => disposed++;

// The Flash adapter has already attached a Bitmap when the image parser completes.
const bitmap = new DisplayObject();
container.addChild(bitmap);
const rawImage = { width: 320, height: 200 };
const complete = { content: rawImage };
assert.doesNotThrow(() => container._onLoaderComplete(complete));
assert.equal(container.numChildren, 1);
assert.equal(container.getChildAt(0), bitmap);
assert.doesNotThrow(() => container.advanceFrame());
assert.equal(bitmap.frames, 1);
assert.equal(disposed, 1);
assert.equal(container.events[0], complete);

// Ordinary scene loaders still attach parser display content by default.
const standalone = new LoaderContainer();
standalone._disposeLoader = () => {};
const root = new DisplayObject();
standalone._onLoaderComplete({ content: root });
assert.equal(standalone.getChildAt(0), root);
assert.equal(root.parent, standalone);

// Every URL/loadBytes parse needs a distinct dictionary, including on one Loader.
const parsers = [];
container.load = (_url, _context, _ns, parser) => parsers.push(parser);
container.loadData = (_data, _context, _ns, parser) => parsers.push(parser);
const request = { url: 'first.swf', adaptee: { url: 'first.swf' } };
const oldLog = console.log;
console.log = () => {};
try {
    adapter._delayedLoad(request);
    const first = parsers[0].factory;
    const oldShape = {};
    first.awaySymbols[17] = oldShape;
    adapter._content = { adaptee: bitmap };
    adapter._delayedLoad({ url: 'second.swf', adaptee: { url: 'second.swf' } });
    assert.notEqual(parsers[1].factory, first);
    assert.equal(parsers[1].factory.awaySymbols[17], undefined);
    assert.equal(first.awaySymbols[17], oldShape, 'old timelines retain their dictionary');
    assert.equal(container.numChildren, 0, 'old loader content is detached');
    assert.equal(adapter.content, null);
    adapter._isImage = true;
    adapter.loadBytes({ bytes: new Uint8Array([70, 87, 83]) });
    Loader.executeQueue();
    assert.notEqual(parsers[2].factory, parsers[1].factory);
    assert.equal(adapter._isImage, false);
} finally {
    console.log = oldLog;
}
console.log('Passed: image completion preserves display children, frames and events; URL/loadBytes dictionaries are isolated without invalidating old timelines.');
