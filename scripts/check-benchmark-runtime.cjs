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

// Isolate the native memory accessor from display/VM setup; exercise the actual
// implementation on an object without running the ApplicationDomain constructor.
const { ApplicationDomain } = loadTS(path.join(root, '../playerglobal/lib/system/ApplicationDomain.ts'), {
	'@awayfl/avm2': { ASObject: class {} },
	'@awayjs/scene': {},
	'../media/Sound': {},
});
const domain = Object.create(ApplicationDomain.prototype);
const memory = { buffer: new ArrayBuffer(16) };
domain.domainMemory = memory;
const first = domain.internal_memoryView;
assert.equal(first.buffer, memory.buffer);
assert.equal(domain.internal_memoryView, first);
memory.buffer = new ArrayBuffer(32);
const grown = domain.internal_memoryView;
assert.notEqual(grown, first);
assert.equal(grown.buffer, memory.buffer);
const replacement = { buffer: new ArrayBuffer(64) };
domain.domainMemory = replacement;
assert.equal(domain.domainMemory, replacement);
assert.equal(domain.internal_memoryView.buffer, replacement.buffer);

console.log('Passed: original ZWS payload, first memory binding, stable view reuse, buffer growth, and rebinding.');
