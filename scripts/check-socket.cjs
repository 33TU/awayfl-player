const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
global.self = globalThis;
global.window = globalThis;
global.document = { baseURI: 'https://localhost/game/' };
const { DataBuffer } = require('@awayjs/graphics');
const errors = Object.fromEntries(['InvalidEnumError', 'InvalidArgumentError', 'ParamRangeError', 'NullPointerError', 'EOFError'].map(name => [name, { message: name, code: name === 'EOFError' ? 2030 : 2000 }]));
const events = [];
class Event {
    constructor(type, bubbles = false, cancelable = false, value = 0, total = 0) {
        Object.assign(this, { type, bubbles, cancelable, bytesLoaded: value, bytesTotal: total });
    }
}
Event.CONNECT = 'connect'; Event.CLOSE = 'close';
class ProgressEvent extends Event {}
ProgressEvent.SOCKET_DATA = 'socketData';
const sec = {
    player: { config: { socketProxy: (host, port) => `wss://proxy.test/?host=${host}&port=${port}` } },
    flash: { utils: { ByteArray: function () { const b = new DataBuffer(); b.sec = sec; return b; } },
        events: { Event, ProgressEvent, IOErrorEvent: Event, SecurityErrorEvent: Event } },
    throwError(name, info) { const e = new Error(info.message); e.name = name; e.errorID = info.code; throw e; },
};
class EventDispatcher {
    constructor() { this.sec = sec; }
    dispatchEvent(event) { events.push(event); }
}
class FakeWebSocket {
    static instances = [];
    constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; FakeWebSocket.instances.push(this); }
    open() { this.readyState = 1; this.onopen?.({}); }
    message(bytes) { this.onmessage?.({ data: Uint8Array.from(bytes).buffer }); }
    send(bytes) { this.sent.push(new Uint8Array(bytes).slice()); }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
}
global.WebSocket = FakeWebSocket;
const source = fs.readFileSync(path.resolve(__dirname, '../../playerglobal/lib/net/Socket.ts'), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } });
const native = {};
new Function('require', 'exports', outputText)(id => {
    if (id === '@awayfl/avm2') return { axCoerceString: value => value == null ? null : String(value), Errors: errors };
    if (id.endsWith('/EventDispatcher')) return { EventDispatcher };
    if (id.endsWith('/ProgressEvent')) return { ProgressEvent };
    if (id.endsWith('/Event')) return { Event };
    throw Error(`Unexpected runtime dependency ${id}`);
}, native);
const { Socket } = native;
const last = () => FakeWebSocket.instances.at(-1);
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
    const s = new Socket();
    assert.equal(s.timeout, 20000); assert.equal(s.endian, 'bigEndian'); assert.equal(s.objectEncoding, 3);
    assert.equal(s.connected, false); assert.equal(s.bytesAvailable, 0);
    for (const op of [() => s.readInt(), () => s.writeByte(1), () => s.flush(), () => s.close()]) assert.throws(op, { name: 'flash.errors.IOError' });
    assert.throws(() => s.connect('host', 65536), { name: 'SecurityError' });
    assert.throws(() => { s.endian = 'wrong'; }, { name: 'ArgumentError' });
    assert.throws(() => { s.objectEncoding = 2; }, { name: 'ArgumentError' });
    s.connect('host', 1234); assert.throws(() => s.close(), { name: 'flash.errors.IOError' }); let ws = last(); assert.equal(ws.binaryType, 'arraybuffer'); ws.open();
    assert.equal(s.connected, true); assert.equal(events.at(-1).type, 'connect'); assert.equal(events.at(-1).target, s);
    s.writeInt(0x01020304); s.writeUTF('é');
    assert.equal(ws.sent.length, 0); assert.equal(s.bytesPending, 8);
    s.flush(); assert.deepEqual([...ws.sent[0]], [1, 2, 3, 4, 0, 2, 0xc3, 0xa9]); assert.equal(s.bytesPending, 0);
    s.flush(); assert.equal(ws.sent.length, 1);
    ws.message([1]); assert.throws(() => s.readInt(), { name: 'flash.errors.EOFError' }); assert.equal(s.bytesAvailable, 1);
    ws.message([2, 3, 4, 0, 2, 0xc3]); assert.equal(s.readInt(), 0x01020304);
    assert.throws(() => s.readUTF(), { name: 'flash.errors.EOFError' }); assert.equal(s.bytesAvailable, 3);
    ws.message([0xa9]); assert.equal(s.readUTF(), 'é'); assert.equal(s.bytesAvailable, 0);
    assert.equal(events.at(-1).type, 'socketData'); assert.equal(events.at(-1).bytesLoaded, 4); assert.equal(events.at(-1).bytesTotal, 0);
    // UTF lengths are unsigned, including values over 32767.
    s.writeUTF('x'.repeat(40000)); s.flush(); ws.message(ws.sent.at(-1)); assert.equal(s.readUTF().length, 40000);
    assert.throws(() => s.writeUTF('x'.repeat(65536)), { name: 'RangeError' }); assert.equal(s.bytesPending, 0);
    s.endian = 'littleEndian'; s.writeShort(0x1234); s.writeDouble(1.5); s.flush(); ws.message(ws.sent.at(-1));
    assert.equal(s.readUnsignedShort(), 0x1234); assert.equal(s.readDouble(), 1.5);
    const bytes = new sec.flash.utils.ByteArray(); bytes.writeByte(9); bytes.position = 1;
    ws.message([4, 5, 6]); s.readBytes(bytes, 2, 0); assert.deepEqual([...bytes.getBytes()], [9, 0, 4, 5, 6]); assert.equal(bytes.position, 1);
    s.writeBytes(bytes, 2, 2); s.flush(); assert.deepEqual([...ws.sent.at(-1)], [4, 5]);
    s.writeMultiByte('é', 'UTF-8'); s.flush(); ws.message(ws.sent.at(-1)); assert.equal(s.readMultiByte(2, 'utf-8'), 'é');
    s.writeMultiByte('A\u0080é', 'iso-8859-1'); s.flush(); ws.message(ws.sent.at(-1)); assert.equal(s.readMultiByte(3, 'iso-8859-1'), 'A\u0080é');
    assert.throws(() => s.writeMultiByte('test', 'unsupported'), { name: 'ArgumentError' });
    // Compaction preserves unread bytes and bounded growth across messages.
    ws.message(new Uint8Array(131072).fill(7)); s._input.position = 100000; ws.message([8]);
    assert.equal(s.bytesAvailable, 31073); assert.equal(s._input.position, 0); assert.equal(s._input.length, 31073);
    s.readBytes(new sec.flash.utils.ByteArray(), 0, 31072); assert.equal(s.readByte(), 8);
    const oldMessage = ws.onmessage; const oldClose = ws.onclose;
    s.connect('next', 4321); ws = last(); ws.open(); oldMessage({ data: new Uint8Array([99]).buffer }); oldClose({});
    assert.equal(s.connected, true); assert.equal(s.bytesAvailable, 0); assert.equal(s.endian, 'littleEndian');
    const count = events.length; s.close(); assert.equal(events.length, count); assert.equal(s.connected, false);
    s.connect('host', 1234); ws = last(); ws.open(); ws.close(); assert.equal(events.at(-1).type, 'close');
    s.connect('host', 1234); ws = last(); ws.onerror({}); assert.equal(events.at(-1).type, 'ioError'); assert.equal(s.didFailureOccur(), true);
    s.connect('host', 1234); ws = last(); ws.open(); ws.onmessage({ data: 'text is not a TCP byte frame' }); assert.equal(events.at(-1).type, 'ioError');
    s.timeout = 1; s.connect('host', 1234); await tick(10); assert.equal(s.connected, false); assert.equal(events.at(-1).type, 'ioError');
    sec.player.config.socketProxy = []; new Socket('missing', 1234); await tick(); assert.equal(events.at(-1).type, 'securityError');
    sec.player.config.socketProxy = [{ host: 'allowed', port: 1234, proxyUrl: 'wss://proxy.test/socket' }];
    const other = new Socket('allowed', 1234); assert.equal(last().url, 'wss://proxy.test/socket'); last().open(); other.close();
    console.log('Passed: Socket buffering/flush, fragmented reads/UTF, endian, byte offsets, compaction, events, failures, timeout, reconnect and proxy routing.');
})().catch(error => { console.error(error); process.exitCode = 1; });
