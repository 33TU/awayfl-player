const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const exports_ = {};
new Function('require', 'exports', ts.transpileModule(fs.readFileSync(
    path.resolve(__dirname, '../../avm2/lib/nat/ASString.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText)(id => {
    if (id === './ASObject') return { ASObject: class {} };
    if (id === './addPrototypeFunctionAlias') return {
        addPrototypeFunctionAlias: (target, key, fn) => { target[key] = fn; },
    };
    return {};
}, exports_);
const { ASString } = exports_;
const proto = {};
ASString.classInitializer.call({ dPrototype: proto });

// Flash expectations also covered by Ruffle's string_substr_negative fixture:
// https://github.com/ruffle-rs/ruffle/tree/master/tests/tests/swfs/avm2/string_substr_negative
const cases = [
    ['abcdefg', [3, 5], 'defg'],
    ['abcdefg', [0, -2], 'abcde'],
    ['abcdefg', [1, -2], 'bcdef'],
    ['abcdefg', [2, -2], ''],
    ['abcdefg', [1, -4], 'bcd'],
    ['abcdefg', [1, -Infinity], ''],
    ['abcdefg', [2, -1], ''],
    ['abcdefg', [2, 9], 'cdefg'],
    ['abcdefg', [0, -3], 'abcd'],
    ['abcdefg', [2, -7], ''],
    ['abcdefg', [5, -10], ''],
    ['abcdefg', [-6, -4], 'bcd'],
    ['abcdefg', [-99, -4], 'abc'],
    ['abcdefg', [NaN, -4], 'abc'],
    ['abcdefg', [Infinity, -4], ''],
    ['abcdefg', [-Infinity, -4], 'abc'],
    ['abcdefg', [0, -0.5], ''],
    ['abcdefg', [0, -1.5], 'abcde'],
    ['abcdefg', [1.9, 2.9], 'bc'],
    ['abcdefg', [1, Infinity], 'bcdefg'],
    ['abcdefg', [1, NaN], ''],
    ['abcdefg', [1, undefined], ''],
    ['abcdefg', [1], 'bcdefg'],
    ['abcdefg', [], 'abcdefg'],
    ['abcdefg', ['1', '-4'], 'bcd'],
    ['', [0, -4], ''],
    ['a😀b.swf', [0, -4], 'a😀b'],
];
for (const [value, args, expected] of cases) {
    assert.equal(new ASString(value).substr(...args), expected, `native substr: ${value}, ${args}`);
    assert.equal(proto.$Bgsubstr.apply(value, args), expected, `prototype substr: ${value}, ${args}`);
}
// Both the URL and exported class name depend on the same filename operation.
const file = 'houses/house-ice.swf';
const base = proto.$Bgsubstr.call(file, 0, -4);
assert.equal(`maps/${base}_preview.swf`, 'maps/houses/house-ice_preview.swf');
assert.equal(proto.$Bgsubstr.call(base, file.lastIndexOf('/') + 1).split('-').join('_') + '_preview',
    'house_ice_preview');
assert.equal(proto.$Bgsubstr.call(1234567, 0, -4), '123', 'generic receiver coercion');
console.log('Passed: Flash substr negative lengths, offsets, coercion, UTF-16, and house preview URL/class names.');
