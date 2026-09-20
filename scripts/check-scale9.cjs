const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

global.self = globalThis;
global.window = globalThis;
const { Vector3D } = require('@awayjs/core');
const { Float2Attributes } = require('@awayjs/stage');
const source = path.resolve(__dirname, '../../renderer/lib/utils/GeneratorUtils.ts');
const exports_ = {};
new Function('require', 'exports', ts.transpileModule(fs.readFileSync(source, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText)(require, exports_);
const { MeshView, GeneratorUtils } = exports_;

// A translucent rectangle, triangulated just like a SWF fill. Nine-slice
// subdivision must preserve coverage: duplicate triangles compound its alpha.
const positions = new Float2Attributes();
positions.set(new Float32Array([0, 0, 10, 0, 10, 10, 0, 0, 10, 10, 0, 10]));
const uvs = new Float2Attributes();
uvs.set(new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]));
let mesh = MeshView.fromAttributes([positions, uvs], 6, 3);
assert.equal(mesh.poly.length, 2, 'one polygon per triangle, not per vertex');
assert.notEqual(mesh.poly[0], mesh.poly[1]);
function area(m) {
    return m.poly.reduce((sum, p) => {
        const [a, b, c] = p.vertices.map(v => v.getData(0));
        return sum + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    }, 0);
}
assert.equal(area(mesh), 100);
for (const [axis, boundary] of [[0, 2], [0, 8], [1, 2], [1, 8]]) {
    mesh = GeneratorUtils.SliceAllNaive(mesh, new Vector3D(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, 0), boundary);
    assert.ok(Math.abs(area(mesh) - 100) < 0.001, 'subdivision must preserve total covered area');
}
for (const poly of mesh.poly) {
    for (const vertex of poly.vertices) {
        const p = vertex.getData(0), uv = vertex.getData(1);
        assert.ok(Math.abs(uv[0] - p[0] / 10) < 0.00001);
        assert.ok(Math.abs(uv[1] - p[1] / 10) < 0.00001);
    }
}
assert.equal(MeshView.fromAttributes([positions], 0, 3).poly.length, 0);
console.log('Passed: nine-slice triangle coverage, area conservation across four cuts, interpolated UVs, empty geometry.');
