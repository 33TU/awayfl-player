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
const { ByteArray } = loadTS(path.join(root, '../avm2/lib/natives/byteArray.ts'), {
	'@awayjs/graphics': { DataBuffer, assert },
	'../run/checkValue': { checkValue: fail },
	'../run/axCoerceName': { axCoerceName: fail },
	'../nat/ASObject': { ASObject: class {} },
	'@awayfl/swf-loader': { release: true, isNumeric: fail, unexpected: fail },
	'../amf': {},
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

console.log('Passed: ZWS payload; native ByteArray zero fill and storage lifecycle; all 10 memory opcodes across growth/rebinding.');
