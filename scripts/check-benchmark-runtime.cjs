const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
function loadTS(filename, imports = {}) {
	const source = fs.readFileSync(filename, 'utf8');
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
	});
	const exports = {};
	new Function('require', 'exports', outputText)((name) => {
		assert.ok(Object.hasOwn(imports, name), `Unexpected runtime import: ${name}`);
		return imports[name];
	}, exports);
	return exports;
}

// Test the installed decoder against the benchmark payload independently decoded
// using Python's lzma module. The first eight bytes must reach SWF-mode decoding.
const { LzmaDecoder } = loadTS(path.join(root, 'node_modules/@awayjs/graphics/lib/data/lzma.ts'));
const swf = new Uint8Array(fs.readFileSync(path.join(root, 'src/assets/as3pb-bench.swf')));
assert.equal(Buffer.from(swf.subarray(0, 3)).toString(), 'ZWS');
const broken = new LzmaDecoder(true);
broken.onData = () => {};
assert.throws(() => broken.push(swf.subarray(8)), /Incorrect LZMA properties/);
const chunks = [];
const decoder = new LzmaDecoder(true);
decoder.onData = (bytes) => chunks.push(Buffer.from(bytes));
decoder.onError = (error) => { throw new Error(error); };
decoder.push(swf);
decoder.close();
const payload = Buffer.concat(chunks);
assert.equal(payload.length, 96723);
assert.equal(crypto.createHash('sha256').update(payload).digest('hex'),
	'455e09da1e275ed123042604992e29c50f79a8cae5f3c11b7a6601d71bf8da46');

// Load the real buffer primitives; these globals are only required by their UMD bundle.
global.self = globalThis;
global.window = globalThis;
const { DataBuffer } = require('@awayjs/graphics');
const fail = () => { throw new Error('Unexpected VM operation in storage test'); };
const amf = {};
const { ByteArray } = loadTS(path.join(root, '../avm2/lib/natives/byteArray.ts'), {
	'@awayjs/graphics': { DataBuffer, assert },
	'../run/checkValue': { checkValue: fail },
	'../run/axCoerceName': { axCoerceName: fail },
	'../nat/ASObject': { ASObject: class {} },
	'@awayfl/swf-loader': { release: true, isNumeric: fail, unexpected: fail },
	'../amf': amf,
});
// Match native linking: ByteArray's own methods override DataBuffer's descriptors.
for (const name of Object.getOwnPropertyNames(DataBuffer.prototype)) {
	if (name !== 'constructor' && !Object.hasOwn(ByteArray.prototype, name)) {
		Object.defineProperty(ByteArray.prototype, name, Object.getOwnPropertyDescriptor(DataBuffer.prototype, name));
	}
}
const bytes = new ByteArray();
bytes.writeByte(0xab);
const capacity = bytes.buffer.byteLength;
bytes.length = 0;
bytes.length = 1;
assert.equal(bytes.readUnsignedByte(), 0);
assert.equal(bytes.buffer.byteLength, capacity);
bytes.clear();
bytes.position = 3;
bytes.writeByte(42);
assert.deepEqual(Array.from(bytes.getBytes()), [0, 0, 0, 42]);
bytes.clear();
bytes.axSetNumericProperty(2, 99);
assert.deepEqual(Array.from(bytes.getBytes()), [0, 0, 99]);

// Exercise the native domain accessors without display/VM constructor setup.
const { ApplicationDomain } = loadTS(path.join(root, '../playerglobal/lib/system/ApplicationDomain.ts'), {
	'@awayfl/avm2': { ASObject: class {} },
	'@awayjs/scene': {},
	'../media/Sound': {},
});
const domain = Object.create(ApplicationDomain.prototype);
domain.internal_memoryBinding = { storage: null };
const binding = domain.internal_memoryBinding;
const memory = new ByteArray();
memory.length = 16;
domain.domainMemory = memory;
const storage = binding.storage;
const first = domain.internal_memoryView;
assert.equal(first.buffer, memory.buffer);
assert.equal(domain.internal_memoryView, first);
memory.length = 512;
const grown = domain.internal_memoryView;
assert.notEqual(grown, first);
assert.equal(binding.storage, storage);
assert.equal(grown.buffer, memory.buffer);
memory.setArrayBuffer(new ArrayBuffer(32));
assert.equal(binding.storage, storage);
assert.equal(domain.internal_memoryView.buffer, memory.buffer);
const otherDomain = Object.create(ApplicationDomain.prototype);
otherDomain.internal_memoryBinding = { storage: null };
otherDomain.domainMemory = memory;
assert.equal(otherDomain.internal_memoryBinding.storage, storage);
const replacement = new ByteArray();
replacement.length = 64;
domain.domainMemory = replacement;
assert.equal(domain.internal_memoryBinding, binding);
assert.equal(domain.domainMemory, replacement);
assert.equal(domain.internal_memoryView.buffer, replacement.buffer);
assert.equal(domain.internal_memoryView, replacement.internalMemoryStorage.view);
assert.equal(otherDomain.domainMemory, memory);
memory.length = 1024;
assert.equal(otherDomain.internal_memoryView.buffer, memory.buffer);
assert.equal(domain.internal_memoryView.buffer, replacement.buffer);
domain.domainMemory = null;
assert.equal(binding.storage, null);
assert.equal(domain.internal_memoryView, null);

// Execute the actual emitted memory operations. Both a resize and a rebind must
// be visible between operations without resolving the domain a second time.
const bytecodes = loadTS(path.join(root, '../avm2/lib/Bytecode.ts'));
const inline = loadTS(path.join(root, '../avm2/lib/gen/emiters/emitInlineVars.ts'));
const { emitDomainMemOppcodes } = loadTS(path.join(root, '../avm2/lib/gen/emiters/emitDomainMemOppcodes.ts'), {
	'../../Bytecode': bytecodes,
	'./emitInlineVars': inline,
});
function emit(opcode) {
	const lines = [];
	const aliases = { stack1: 'local7' };
	emitDomainMemOppcodes({
		currentOpcode: { name: bytecodes.Bytecode[opcode] },
		evalStackIndex: (n) => 1 - n,
		isThisAlias: () => false,
		getConstAlias: (name) => aliases[name] || name,
		popAnyAlias: (name) => { delete aliases[name]; },
		emitMain: (line) => lines.push(line),
	});
	return lines.join('\n');
}
for (const [load, store, setter, a, b] of [
	['LI8', 'SI8', 'setUint8', 255, 42],
	['LI16', 'SI16', 'setUint16', 65535, 1234],
	['LI32', 'SI32', 'setInt32', -123456, 42],
	['LF32', 'SF32', 'setFloat32', 1.5, 2.5],
	['LF64', 'SF64', 'setFloat64', Math.PI, -Math.PI],
]) {
	for (const rebind of [false, true]) {
		const initial = new ByteArray();
		initial.length = 16;
		domain.domainMemory = initial;
		domain.internal_memoryView[setter](4, a, true);
		let resolutions = 0;
		const context = { get domainMemoryBinding() { resolutions++; return binding; } };
		const change = () => {
			if (rebind) {
				domain.domainMemory = new ByteArray();
			} else {
				initial.length = initial.buffer.byteLength * 2;
			}
			domain.internal_memoryView[setter](4, b, true);
		};
		const read = new Function('context', 'change', `
			let domainMemory, local7 = 4, stack1 = 4;
			${emit(load)}
			const first = stack1;
			change(); stack1 = 4;
			${emit(load)}
			return [first, stack1, local7];
		`);
		assert.deepEqual(read(context, change), [a, b, 4]);
		assert.equal(resolutions, 1);
		const oldView = domain.internal_memoryView;
		const write = new Function('context', 'change', 'value', `
			let domainMemory, local7 = 4, stack1 = 4, stack0 = value;
			${emit(store)}
			change();
			${emit(store)}
		`);
		write(context, change, a);
		const getter = setter.replace('set', 'get');
		assert.equal(oldView[getter](4, true), a);
		assert.equal(domain.internal_memoryView[getter](4, true), a);
	}
}

// The transpile-only build must not need a runtime MouseButtons enum. Exercise
// the actual event adapter with individual and combined DOM button masks.
const { MouseEvent } = loadTS(path.join(root, '../playerglobal/lib/events/MouseEvent.ts'), {
	'./Event': { Event: class {} },
	'@awayfl/swf-loader': { notImplemented: fail },
});
for (const [buttons, down] of [[0, false], [1, true], [2, false], [4, false], [3, true], [5, true], [6, false]]) {
	const event = new MouseEvent('mouseMove');
	event.fillFromAway({ target: { adapter: {} }, currentTarget: { adapter: {} }, buttons });
	assert.equal(event.buttonDown, down);
}

// Execute the real AMF codec with native ByteArray storage and a minimal VM
// adapter. Browser integration separately verifies real AS3 class construction.
Object.assign(amf, loadTS(path.join(root, '../avm2/lib/amf.ts'), {
	'@awayjs/graphics': { assert },
	'@awayjs/core': { ByteArray: class {} },
	'./run/initializeAXBasePrototype': {},
	'@awayfl/swf-loader': {
		release: true,
		isNumeric: key => /^\d+$/.test(String(key)),
		StringUtilities: {
			utf8decode: value => new TextEncoder().encode(value),
			utf8encode: value => new TextDecoder().decode(value),
		},
	},
	'./run/forEachPublicProperty': {
		forEachPublicProperty: (array, callback) => array.value.forEach((v, i) => callback(i, v)),
	},
}));
const notType = { axIsType: () => false };
const amfSec = {
	AXArray: { axIsType: value => Array.isArray(value?.value) },
	AXDate: notType, AXXML: notType,
	Int32Vector: notType, Uint32Vector: notType, Float64Vector: notType, ObjectVector: notType,
	createArray: value => ({
		value,
		axHasPublicProperty: i => Object.hasOwn(value, i),
		axGetPublicProperty: i => value[i],
		axSetPublicProperty: (i, v) => { value[i] = v; },
	}),
	throwError: name => { const error = new Error(name); error.name = name; throw error; },
};
function newAMFBytes(contents = []) {
	const result = new ByteArray(contents);
	result.sec = amfSec;
	return result;
}
function AMFByteArrayLoader() { return newAMFBytes(); }
AMFByteArrayLoader.axIsType = value => value instanceof ByteArray;
amfSec.flash = { utils: { ByteArray: AMFByteArrayLoader } };

// Ruffle's bytearray_serialization expected output, checked in both directions:
// https://github.com/ruffle-rs/ruffle/blob/1bc8bbf7829c0ce9f127a422045bf96a0814469c/tests/tests/swfs/avm2/bytearray_serialization/output.txt
const hello = [0, 11, ...Buffer.from('hello world')];
const helloAMF = [12, 27, ...hello];
for (const endian of ['bigEndian', 'littleEndian']) {
	const source = newAMFBytes(hello);
	source.endian = endian;
	source.position = 5;
	const encoded = newAMFBytes();
	encoded.endian = endian;
	encoded.writeObject(source);
	assert.deepEqual(Array.from(encoded.getBytes()), helloAMF);
	assert.equal(source.position, 5);
	const input = newAMFBytes(helloAMF);
	input.endian = endian;
	const decoded = input.readObject();
	assert.ok(decoded instanceof ByteArray);
	assert.deepEqual(Array.from(decoded.getBytes()), hello);
	assert.equal(decoded.position, 0);
	assert.equal(decoded.endian, 'bigEndian');
	assert.equal(input.bytesAvailable, 0);
}

// References share the AMF object table with their enclosing Array. Repeated
// instances retain identity; distinct buffers with equal contents stay distinct.
const shared = newAMFBytes([0, 128, 255]);
const separate = newAMFBytes([0, 128, 255]);
const empty = newAMFBytes();
const list = amfSec.createArray([shared, shared, separate, empty, empty]);
const referenceWire = [9, 11, 1, 12, 7, 0, 128, 255, 12, 2, 12, 7, 0, 128, 255, 12, 1, 12, 6];
const referenceOutput = newAMFBytes();
referenceOutput.writeObject(list);
assert.deepEqual(Array.from(referenceOutput.getBytes()), referenceWire);
const values = newAMFBytes(referenceWire).readObject().value;
assert.equal(values[0], values[1]);
assert.notEqual(values[0], values[2]);
assert.equal(values[3], values[4]);
assert.equal(values[3].length, 0);
assert.deepEqual(Array.from(values[2].getBytes()), [0, 128, 255]);

const trailing = newAMFBytes([12, 1, 4, 7]);
assert.equal(trailing.readObject().length, 0);
assert.equal(trailing.position, 2);
assert.equal(trailing.readObject(), 7);
const selfEncoded = newAMFBytes([1, 2, 3]);
selfEncoded.position = 3;
selfEncoded.writeObject(selfEncoded);
assert.deepEqual(Array.from(selfEncoded.getBytes()), [1, 2, 3, 12, 7, 1, 2, 3]);
selfEncoded.position = 3;
assert.deepEqual(Array.from(selfEncoded.readObject().getBytes()), [1, 2, 3]);
for (const wire of [[12], [12, 0x80], [12, 7, 1, 2], [12, 0xff, 0xff, 0xff, 0xff]]) {
	assert.throws(() => newAMFBytes(wire).readObject(), { name: 'flash.errors.EOFError' });
}
// U29 headers are unsigned, but the INTEGER marker carries signed 29-bit data.
for (const value of [-268435456, -1, 0, 127, 128, 16383, 16384, 2097151, 2097152, 268435455]) {
	const data = newAMFBytes();
	data.writeObject(value);
	data.position = 0;
	assert.equal(data.readObject(), value);
}
for (const length of [0, 63, 64, 8191, 8192, 1048575, 1048576]) {
	const data = newAMFBytes(), source = newAMFBytes();
	source.length = length;
	if (length) source.axSetNumericProperty(length - 1, 255);
	data.writeObject(source);
	data.position = 0;
	const decoded = data.readObject();
	assert.equal(decoded.length, length);
	assert.deepEqual(decoded.getBytes(), source.getBytes());
}
// Check the high header bit without allocating a 256 MB payload.
const large = newAMFBytes(), headerOnly = newAMFBytes();
Object.defineProperty(large, 'length', { value: 0x0fffffff });
headerOnly.writeBytes = (source, offset, length) => {
	assert.equal(source, large); assert.equal(offset, 0); assert.equal(length, 0x0fffffff);
};
headerOnly.writeObject(large);
assert.deepEqual(Array.from(headerOnly.getBytes()), [12, 255, 255, 255, 255]);

console.log('Passed: ZWS payload; ByteArray storage; all 10 memory opcodes; mouse-button adaptation; AMF3 ByteArray wire fixtures, references, bounds, and U29 headers.');
