const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const TRAIT = { Slot: 0, Const: 6, Method: 1, Getter: 2, Setter: 3 };
class Multiname {}
Multiname.FromSimpleName = name => ({ name });
class XML {
    constructor(markup) { this.markup = markup; this.children = []; this.sec = sec; }
    setProperty() {}
    appendChild(child) { this.children.push(child); }
}
const xmlClass = { Create: markup => new XML(markup) };
const imports = {
    '@awayfl/swf-loader': { release: true, isNullOrUndefined: o => o == null },
    './xml': { escapeAttributeValue: s => s },
    '../abc/lazy/Multiname': { Multiname },
    '../abc/lazy/Namespace': { Namespace: { PUBLIC: {} } },
    '../abc/lazy/CONSTANT': { CONSTANT: { QName: 7, QNameA: 13 } },
    '../abc/lazy/TRAIT': { TRAIT },
};
const mod = {};
new Function('require', 'exports', ts.transpileModule(fs.readFileSync(
    path.resolve(__dirname, '../../avm2/lib/natives/describeType.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText)(id => imports[id] || {}, mod);
const sec = {
    box: o => o, createObject: () => ({}),
    createArray: value => ({ value, push: (...v) => value.push(...v), pop: () => value.pop() }),
    AXFunction: { axIsType: () => false }, system: { getClass: () => xmlClass }, AXXML: xmlClass,
};
function trait(name, kind) {
    return { kind, multiname: { name, namespace: { isPublic: () => true, uri: '', reflectedURI: '' },
        toFQNString: () => name }, typeName: { toFQNString: () => 'uint' } };
}
const cls = { sec, classInfo: {
    instanceInfo: { multiname: { toFQNString: () => 'Test' }, isInterface: () => false,
        traits: { traits: [trait('instanceConst', TRAIT.Const), trait('instanceVar', TRAIT.Slot)] } },
    traits: { traits: [trait('NUMBER_1', TRAIT.Const), trait('mutable', TRAIT.Slot)] },
} };
sec.AXObject = cls;
const flags = 0x0100 | 0x0008 | 0x0002;
for (const [value, names] of [[cls, ['NUMBER_1', 'mutable']], [{ axClass: cls, sec }, ['instanceConst', 'instanceVar']]]) {
    const json = mod.describeTypeJSON(sec, value, flags);
    assert.deepEqual(json.$Bgtraits.$Bgvariables.value.map(t => [t.$Bgname, t.$Bgaccess]),
        [[names[0], 'readonly'], [names[1], 'readwrite']]);
    const xml = mod.describeType(sec, value, flags);
    assert.ok(xml.children.some(c => c.markup === `<constant name="${names[0]}" type="uint"/>`));
    assert.ok(xml.children.some(c => c.markup === `<variable name="${names[1]}" type="uint"/>`));
}
console.log('Passed: static and instance constants reflect as readonly constants; mutable slots remain variables.');
