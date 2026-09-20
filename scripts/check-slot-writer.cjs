const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const avm2 = path.resolve(__dirname, '../../avm2/lib');
function load(file, imports = {}) {
    const { outputText } = ts.transpileModule(fs.readFileSync(path.join(avm2, file), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    });
    const exports = {};
    new Function('require', 'exports', outputText)(name => {
        assert.ok(Object.hasOwn(imports, name), `Unexpected import: ${name}`);
        return imports[name];
    }, exports);
    return exports;
}
const isNumeric = value => /^-?\d+$/.test(String(value));
const swf = { release: true, isNumeric };
const { TRAIT } = load('abc/lazy/TRAIT.ts', { '@awayfl/swf-loader': swf });
const { NamespaceType } = load('abc/lazy/NamespaceType.ts', { '@awayfl/swf-loader': swf });
const { Bytecode } = load('Bytecode.ts');
const errors = { CannotAssignToMethodError: 'method', ConstWriteError: 'readonly' };
const { ASObject } = load('nat/ASObject.ts', {
    '@awayfl/swf-loader': swf, '@awayjs/graphics': { assert },
    '../abc/ops': { Bytecode }, '../abc/lazy/TRAIT': { TRAIT },
    '../abc/lazy/Multiname': {}, './addPrototypeFunctionAlias': {},
    '../run/checkValue': {}, './makeMultiname': {}, '../run/axCoerceString': {},
    '../nat/qualifyPublicName': {}, '../run/axCoerceName': { axCoerceName: String },
    './rn': {}, '../errors': { Errors: errors }, '../run/validateCall': {}, '../run/validateConstruct': {},
});
const { RuntimeTraits } = load('abc/lazy/RuntimeTraits.ts', {
    '@awayfl/swf-loader': swf, '@awayjs/graphics': { assert },
    './NamespaceType': { NamespaceType }, './TRAIT': { TRAIT },
});
const { IS_AX_CLASS } = load('run/AXClass.ts');
const IS_EXTERNAL_CLASS = Symbol('external');
const { createSlotWriter } = load('run/createSlotWriter.ts', {
    '@awayfl/swf-loader': swf, '../abc/lazy/TRAIT': { TRAIT },
    '../nat/ASObject': { ASObject }, '../ext/external': { IS_EXTERNAL_CLASS },
    './AXClass': { IS_AX_CLASS },
});
const namespace = { mangledName: 'public', type: NamespaceType.Public };
const mn = { name: 'position', namespaces: [namespace], mutable: false, isRuntime: () => false };
function traitsFor(kind, mangled, type = null, ns = namespace) {
    const traits = new RuntimeTraits(null, null, {});
    traits.addTrait({ kind, multiname: {
        name: 'position', namespaces: [ns], getMangledName: () => mangled,
    }, getType: () => type });
    return traits;
}
function objectFor(traits) {
    return Object.assign(Object.create(ASObject.prototype), {
        [IS_AX_CLASS]: true, traits,
        axClass: { name: { name: 'Test' } },
        sec: { throwError: (name, code) => { throw new Error(`${name}:${code}`); } },
    });
}
let fallbacks = 0;
const fallback = (value, object) => {
    fallbacks++;
    if (!object) throw new Error('null receiver');
    object.axSetProperty(mn, value, Bytecode.SETPROPERTY);
};
const writer = createSlotWriter(mn, fallback);
let coerces = 0, lookups = 0;
const intType = { axCoerce: value => { coerces++; return value | 0; } };
const traitsA = traitsFor(TRAIT.Slot, '$Bgposition', intType);
const getTrait = traitsA.getTrait.bind(traitsA);
traitsA.getTrait = (...args) => { lookups++; return getTrait(...args); };
const a = objectFor(traitsA);
writer('7.9', a); writer(-1.9, a);
assert.equal(a.$Bgposition, -1);
assert.equal(coerces, 2); // Every write retains coercion.
assert.equal(lookups, 1); // Only resolution is cached.
assert.equal(fallbacks, 0);
const b = objectFor(traitsFor(TRAIT.Slot, '$OtherPosition', { axCoerce: String }));
writer(22, b); writer(4.8, a);
assert.equal(b.$OtherPosition, '22');
assert.equal(a.$Bgposition, 4);
assert.equal(lookups, 2);
// Same traits but overridden MOP: never bypass native/Proxy handling.
let customCalls = 0;
a.axSetProperty = () => customCalls++;
writer(9, a);
assert.equal(customCalls, 1);
delete a.axSetProperty;
a[IS_EXTERNAL_CLASS] = true;
writer(10, a);
assert.equal(fallbacks, 2);
delete a[IS_EXTERNAL_CLASS];
// Accessors retain dispatch/coercion; readonly and method errors match the VM.
let accessed;
const accessor = objectFor(traitsFor(TRAIT.GetterSetter, '$Bgposition', intType));
Object.defineProperty(accessor, '$Bgposition', { set: value => { accessed = value; } });
writer('13.5', accessor);
assert.equal(accessed, 13);
for (const kind of [TRAIT.Getter, TRAIT.Const, TRAIT.Method]) {
    const receiver = objectFor(traitsFor(kind, '$Bgposition'));
    assert.throws(() => writer(1, receiver), /ReferenceError/);
}
assert.throws(() => writer(1, null), /null receiver/);
const dynamic = objectFor(new RuntimeTraits(null, null, {}));
writer(11, dynamic);
assert.equal(dynamic.$Bgposition, 11);
for (const name of [{ ...mn, mutable: true }, { ...mn, isRuntime: () => true }, { ...mn, name: '0' }]) {
    assert.equal(createSlotWriter(name, fallback), fallback);
}
const privateNS = { mangledName: 'private', type: NamespaceType.Private };
const privateName = { ...mn, namespaces: [privateNS] };
const privateObject = objectFor(traitsFor(TRAIT.Slot, '$PrivatePosition', null, privateNS));
createSlotWriter(privateName, () => assert.fail('Private slot should resolve'))(42, privateObject);
assert.equal(privateObject.$PrivatePosition, 42);
// Coercion can re-enter with another class; the outer receiver/key stay intact.
const reentrant = objectFor(traitsFor(TRAIT.Slot, '$Outer', {
    axCoerce: value => { writer('nested', b); return value | 0; },
}));
writer(99, reentrant);
assert.equal(reentrant.$Outer, 99);
assert.equal(b.$OtherPosition, 'nested');
const resolvingTraits = traitsFor(TRAIT.Slot, '$Resolved');
const resolvingTrait = resolvingTraits.getTrait(mn.namespaces, mn.name);
resolvingTrait.getType = () => { writer(5, a); return intType; };
const resolving = objectFor(resolvingTraits);
writer('23.8', resolving);
assert.equal(resolving.$Resolved, 23);
writer(24, resolving);
assert.equal(resolving.$Resolved, 24);
console.log('Passed: cached slot writes preserve coercion, namespaces, receiver changes, native overrides, accessors, errors, and reentrancy.');
