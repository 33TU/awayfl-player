// Run against a local Chrome debugging port: node scripts/check-overlay-pixels.cjs 9234
// Uses an independent canvas; does not alter the loaded SWF.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
function load(file, imports) {
    const out = {};
    new Function('require', 'exports', ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '../../stage/lib/filters/tasks/webgl', file), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    }).outputText)(name => imports[name] || {}, out);
    return out;
}
const modes = ['DIFFERENCE', 'SUBTRACT', 'INVERT', 'DARKEN', 'LIGHTEN', 'HARDLIGHT', 'OVERLAY', 'SCREEN'];
const composition = load('CompositionParts.ts', { '../../../image': { BlendMode: Object.fromEntries(modes.map(m => [m, m.toLowerCase()])) } });
class TaskBaseWebGL { invalidateProgram() {} computeVertexData() {} }
const uv = load('MultipleUVTask.ts', { './TaskBaseWebgGL': { TaskBaseWebGL } });
const { ColorMatrixTask } = load('ColorMatrixTask.ts', { './MultipleUVTask': uv, './CompositionParts': composition });
const task = new ColorMatrixTask();
task.setCompositeBlend('overlay');
// Backdrop coordinates refer to the destination, not to the source texture.
task.source = {}; task.back = { width: 8, height: 4 };
task.inputRect = { width: 1, height: 1 };
task.destRect = { x: 2, y: 1, width: 4, height: 2 };
task._program3D = { uploadUniform() {} };
task.activate({ abstractions: { getAbstraction: () => ({ activate() {} }) } });
assert.deepEqual([...task.uvMatrices[1]], [.25, .25, .5, .5]);
const shader = { vertex: task.getVertexCode(), fragment: task.getFragmentCode() };
function pixels(shader) {
    const results = [];
    for (const context of ['webgl', 'webgl2']) {
        const canvas = document.createElement('canvas'); canvas.width = 4; canvas.height = 1;
        const gl = canvas.getContext(context, { premultipliedAlpha: true, preserveDrawingBuffer: true });
        if (!gl) throw Error(context + ' unavailable');
        const program = gl.createProgram();
        for (const [type, code] of [[gl.VERTEX_SHADER, shader.vertex], [gl.FRAGMENT_SHADER, shader.fragment]]) {
            const s = gl.createShader(type); gl.shaderSource(s, code); gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
            gl.attachShader(program, s);
        }
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
        gl.useProgram(program);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0,0,0,1, 1,0,0,1, 0,1,0,1, 0,1,0,1, 1,0,0,1, 1,1,0,1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(program, 'aPos');
        gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0);
        function texture(slot, data) {
            gl.activeTexture(gl.TEXTURE0 + slot);
            const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, data.length / 4, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(data));
            return t;
        }
        gl.uniform1i(gl.getUniformLocation(program, 'fs0'), 0);
        gl.uniform1i(gl.getUniformLocation(program, 'fs1'), 1);
        const colors = [
            [[102,102,102,102], [180,0,0,255]], // translucent white on red
            [[20,90,30,128], [90,30,100,128]], // both partially transparent
            [[0,0,0,0], [90,40,20,128]], // transparent source preserves backdrop
            [[80,40,20,128], [0,0,0,0]], // transparent backdrop preserves source
            [[0,0,0,255], [200,100,50,255]],
            [[255,255,255,255], [200,100,50,255]],
        ];
        for (const [src, dst] of colors) {
            const a = texture(0, src), b = texture(1, [0,255,0,255, 0,0,255,255, ...dst, 255,0,255,255]);
            gl.viewport(0,0,4,1); gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT);
            gl.uniform4fv(gl.getUniformLocation(program, 'uPosMatrix'), [0,-1,.5,2]);
            gl.uniform4fv(gl.getUniformLocation(program, 'uTexMatrix'), [0,0,1,1, .5,0,.25,1]);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            const actual = new Uint8Array(4); gl.readPixels(2,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,actual);
            const sa = src[3]/255, da = dst[3]/255;
            const expected = src.slice(0,3).map((s,i) => {
                const cs = sa ? s/255/sa : 0, cd = da ? dst[i]/255/da : 0;
                const blend = cd <= .5 ? 2*cs*cd : 1-2*(1-cs)*(1-cd);
                return Math.round(s*(1-da)+dst[i]*(1-sa)+255*sa*da*blend);
            });
            expected.push(Math.round(255*(sa+da*(1-sa))));
            if (actual.some((v,i) => Math.abs(v-expected[i])>2)) throw Error(JSON.stringify({context, src, dst, actual:[...actual], expected}));
            gl.deleteTexture(a); gl.deleteTexture(b);
        }
        if (gl.getError()) throw Error('WebGL error');
        results.push(context + ': 6 overlay pixel cases passed');
        gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    return results;
}
function integration() {
    const player = window._AWAY_DEBUG_PLAYER_?.player;
    if (!player) throw Error('Load the local AwayFL login screen first');
    const stage = player._view.stage, gl = stage.context._gl;
    let Image;
    function walk(n) {
        for (const r of Object.values(n._renderObjects || {}))
            if (r.style?.image && r.getPaddedBounds) Image = r.style.image.constructor;
        for (const c of n._children || []) walk(c);
    }
    walk(player.root);
    if (!Image) throw Error('No cached image constructor available');
    const source = new Image(1, 1, false), target = new Image(4, 1, false);
    const upload = (image, data) => stage.abstractions.getAbstraction(image).getTexture()
        .uploadFromArray(new Uint8Array(data), 0, true);
    const before = gl.getError();
    if (before) throw Error('Scene already has WebGL error: ' + before);
    stage.pushRenderTargetConfig();
    try {
        for (let i = 0; i < 2; i++) {
            upload(source, [255, 255, 255, 102]);
            upload(target, [0,255,0,255, 0,0,255,255, 180,0,0,255, 255,0,255,255]);
            const dest = source.rect.topLeft; dest.x = 2;
            stage.filterManager.copyPixels(source, target, source.rect, dest, true, 'overlay');
            stage.setRenderTarget(target, false);
            const actual = new Uint8Array(16);
            gl.readPixels(0, 0, 4, 1, gl.RGBA, gl.UNSIGNED_BYTE, actual);
            const expected = [0,255,0,255, 0,0,255,255, 210,0,0,255, 255,0,255,255];
            if (actual.some((v, j) => Math.abs(v - expected[j]) > 2))
                throw Error('Filter-manager overlay/copy failed: ' + [...actual]);
            if (gl.getError()) throw Error('Filter-manager WebGL error');
        }
    } finally {
        stage.popRenderTarget();
        source.dispose(); target.dispose();
    }
    return 'Live filter-manager: repeated overlay, destination offset, unaffected pixels and no WebGL errors passed';
}

function displayMasks() {
    const game = _AWAY_DEBUG_PLAYER_.player.root._children.find(n => n.name === 'scene').adapter;
    const s = game.sec;
    function rect(color, x, y, width, height) {
        const sprite = s.flash.display.Sprite.axClass.axConstruct([]);
        sprite.$Bggraphics.$BgbeginFill(color);
        sprite.$Bggraphics.$BgdrawRect(x, y, width, height);
        sprite.$Bggraphics.$BgendFill();
        return sprite;
    }
    for (const mode of ['direct', 'ancestor', 'cachedAncestor']) {
        const root = rect(0xb40000, 0, 0, 64, 64);
        const group = s.flash.display.Sprite.axClass.axConstruct([]);
        const overlay = rect(0xffffff, 0, 0, 64, 64);
        const mask = rect(0, 8, 8, 16, 16);
        overlay.$BgblendMode = 'overlay';
        root.$BgaddChild(group); group.$BgaddChild(overlay); root.$BgaddChild(mask);
        if (mode === 'direct') overlay.$Bgmask = mask;
        else group.$Bgmask = mask;
        if (mode === 'cachedAncestor') group.$BgcacheAsBitmap = true;
        const bitmap = new s.flash.display.BitmapData(64, 64, true, 0);
        try {
            bitmap.$Bgdraw(root);
            for (const [x, y] of [[4, 4], [32, 32], [60, 60]]) {
                const pixel = bitmap.$BggetPixel32(x, y) >>> 0;
                if (pixel !== 0xffb40000)
                    throw Error(`${mode}: masked overlay erased or changed backdrop at ${x},${y}: ${pixel.toString(16)}`);
            }
            const inside = bitmap.$BggetPixel32(12, 12) >>> 0;
            if ((inside >>> 24) !== 255 || inside === 0xffb40000)
                throw Error(`${mode}: overlay disappeared inside mask: ${inside.toString(16)}`);
        } finally {
            bitmap.$Bgdispose();
        }
    }
    // A translucent backdrop must not be source-over blended a second time
    // merely because its composite quad has a mask.
    const inside = [];
    for (const masked of [false, true]) {
        const root = s.flash.display.Sprite.axClass.axConstruct([]);
        root.$Bggraphics.$BgbeginFill(0xb40000, 0.5);
        root.$Bggraphics.$BgdrawRect(0, 0, 64, 64);
        root.$Bggraphics.$BgendFill();
        const overlay = rect(0xffffff, 0, 0, 64, 64);
        overlay.$Bgalpha = 0.5;
        overlay.$BgblendMode = 'overlay';
        root.$BgaddChild(overlay);
        if (masked) {
            const mask = rect(0, 8, 8, 16, 16);
            root.$BgaddChild(mask); overlay.$Bgmask = mask;
        }
        const bitmap = new s.flash.display.BitmapData(64, 64, true, 0);
        try {
            bitmap.$Bgdraw(root);
            inside.push(bitmap.$BggetPixel32(12, 12) >>> 0);
        } finally { bitmap.$Bgdispose(); }
    }
    if (inside[0] !== inside[1]) throw Error('Mask blended the translucent backdrop twice: ' + inside);
    return 'Display-list masks: direct, ancestor and cached-ancestor masks preserve preceding siblings';
}

(async () => {
    const port = Number(process.argv[2] || 9234);
    const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);
    const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Browser timed out')), 30000);
        ws.onmessage = ({data}) => { const m = JSON.parse(data); if (m.id === 1) { clearTimeout(timer); resolve(m); } };
        ws.send(JSON.stringify({id:1, method:'Runtime.evaluate', params:{expression:`[...(${pixels})(${JSON.stringify(shader)}), (${integration})(), (${displayMasks})()]`, returnByValue:true}}));
    });
    ws.close();
    assert.ok(!result.error && !result.result.exceptionDetails, JSON.stringify(result));
    console.log(result.result.result.value.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
