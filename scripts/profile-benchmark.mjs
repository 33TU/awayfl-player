// Attach to a dedicated Chrome started with --remote-debugging-port=9222.
// Node 22+ is required for its built-in WebSocket client. See BENCHMARK.md.
import fs from 'node:fs/promises';
import path from 'node:path';

const endpoint = process.env.CDP_URL || 'http://127.0.0.1:9222';
const url = process.env.BENCHMARK_URL || 'http://127.0.0.1:8080/as3pb-bench.html';
const output = path.resolve(process.env.OUTPUT_DIR || '/tmp/awayfl-benchmark-profile');
const pages = await (await fetch(`${endpoint}/json`)).json();
const page = pages.find(p => p.type === 'page');
if (!page) throw new Error('No Chrome page available');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
const exceptions = [];
ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
        exceptions.push(message.params.exceptionDetails);
    }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
};
const readText = `(() => {
    const queue = [window._AWAY_DEBUG_PLAYER_?.player?.root], seen = new Set(), texts = [];
    while (queue.length) {
        const node = queue.pop();
        if (!node || seen.has(node)) continue;
        seen.add(node);
        if (typeof node.text === 'string') texts.push(node.text);
        if (node._children) queue.push(...node._children);
    }
    return texts.join('\\n');
})()`;

try {
    await fs.mkdir(output, { recursive: true });
    await send('Runtime.enable');
    await send('Page.navigate', { url });
    let text = '';
    for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        text = await evaluate(readText);
        if (text.includes('Done.')) break;
    }
    if (!text.includes('Done.')) throw new Error('Benchmark did not finish its warmup');
    await fs.writeFile(path.join(output, 'warmup.txt'), text);
    await evaluate(`(() => {
        const main = window._AWAY_DEBUG_PLAYER_.player.root._children[0].adapter;
        const methods = [];
        for (let p = main; p; p = Object.getPrototypeOf(p)) methods.push(...Object.getOwnPropertyNames(p));
        window.__benchmarkProfile = { main, method: suffix => methods.find(k => k.endsWith(suffix)) };
    })()`);

    // Warmed invocation, with no debugger or payload interception active.
    await send('Profiler.enable');
    await send('Profiler.setSamplingInterval', { interval: 250 });
    await send('Profiler.start');
    await evaluate(`(() => { const b = window.__benchmarkProfile; b.main[b.method('runBenchmark')](); })()`);
    const { profile } = await send('Profiler.stop');
    await fs.writeFile(path.join(output, 'benchmark.cpuprofile'), JSON.stringify(profile));
    await fs.writeFile(path.join(output, 'profiled.txt'), await evaluate(readText));

    // Resolve anonymous TypeScript ES5 prototype methods to useful names. This
    // source-based naming is intended for the development bundle; production
    // profiles still retain their original call frames and generated AS3 names.
    await send('Debugger.enable');
    const sources = new Map();
    for (const node of profile.nodes) {
        const frame = node.callFrame;
        if (!frame.url || sources.has(frame.scriptId)) continue;
        const source = await send('Debugger.getScriptSource', { scriptId: frame.scriptId });
        sources.set(frame.scriptId, source.scriptSource.split('\n'));
    }
    await send('Debugger.disable');
    const methodName = frame => {
        const lines = sources.get(frame.scriptId);
        const declaration = lines?.[frame.lineNumber] || '';
        const method = declaration.match(/([\w.]+)\s*=\s*function/);
        if (method) return method[1];
        if (lines && /^(get|set)$/.test(frame.functionName)) {
            for (let i = frame.lineNumber; i >= Math.max(0, frame.lineNumber - 14); i--) {
                const property = lines[i].match(/Object.defineProperty\(([^,]+), "([^"]+)"/);
                if (property) return `${property[1]}.${property[2]} ${frame.functionName}`;
            }
        }
        return frame.functionName || `${frame.url}:${frame.lineNumber + 1}`;
    };
    const nodes = new Map(profile.nodes.map(n => [n.id, n])), parents = new Map(), phases = {};
    for (const node of profile.nodes) for (const child of node.children || []) parents.set(child, node.id);
    for (let i = 0; i < profile.samples.length; i++) {
        const leaf = nodes.get(profile.samples[i]);
        let ancestor = leaf, phase = 'other';
        while (ancestor) {
            const name = ancestor.callFrame.functionName;
            if (/^compiled_(serialize|deserialize)(Memory|Bytes)$/.test(name)) {
                phase = name;
                break;
            }
            if (/^compiled_m_benchmark/.test(name)) phase = name;
            ancestor = nodes.get(parents.get(ancestor.id));
        }
        const group = phases[phase] ||= { sampledMs: 0, selfMs: {} };
        const ms = profile.timeDeltas[i] / 1000, name = methodName(leaf.callFrame);
        group.sampledMs += ms;
        group.selfMs[name] = (group.selfMs[name] || 0) + ms;
    }

    // Inspect fresh messages after profiling. Never time this instrumentation.
    const payloads = await evaluate(`(() => {
        const b = window.__benchmarkProfile, fixture = b.main[b.method('createTestData')](100);
        const first = fixture.axGetPublicProperty(0), cls = first.$Bgpayload.axClass;
        const proto = cls.tPrototype, key = '$BgwriteUTFBytes';
        const descriptor = Object.getOwnPropertyDescriptor(proto, key), json = [];
        Object.defineProperty(proto, key, { ...descriptor, value: function(value) {
            json.push(value);
            return descriptor.value.call(this, value);
        }});
        try { b.main[b.method('benchmarkJSON')](fixture, 1); }
        finally { Object.defineProperty(proto, key, descriptor); }

        // Diagnostic projection for this fixture, NOT a replacement JSON implementation.
        const vectorClasses = [first.$Bgsamples.axClass, first.$Bgoffsets.axClass, first.$Bgpositions.axClass];
        const project = value => {
            if (value === null || typeof value !== 'object') return value;
            if (value.axClass === cls) return value.toJSON();
            if (vectorClasses.includes(value.axClass)) {
                return Array.from({ length: value.length }, (_, i) => project(value.axGetPublicProperty(i)));
            }
            const result = {};
            for (const key of Object.keys(value)) if (key.startsWith('$Bg')) result[key.slice(3)] = project(value[key]);
            for (const key of value.axClass.classInfo.instanceInfo.runtimeTraits.getPublicTraitNames()) {
                if (!Object.hasOwn(result, key)) result[key] = project(value.axGetPublicProperty(key));
            }
            return result;
        };
        const projection = Array.from({ length: fixture.length }, (_, i) => JSON.stringify(project(fixture.axGetPublicProperty(i))));
        const byteLength = texts => texts.reduce((n, t) => n + new TextEncoder().encode(t).length, 0);
        const ba = cls.axConstruct([]);
        ba.writeObject(first);
        const amfFirst = Array.from(new Uint8Array(ba._buffer, 0, ba.length));
        ba.position = 0;
        const decoded = ba.readObject().$Bgpayload;
        let actualAmfBytes = 0, amfWithNullPayloadBytes = 0, estimatedBinaryAmfBytes = 0;
        let preservedAmfPayloads = 0;
        for (let i = 0; i < fixture.length; i++) {
            const message = fixture.axGetPublicProperty(i), payload = message.$Bgpayload;
            ba.clear(); ba.writeObject(message); actualAmfBytes += ba.length;
            ba.position = 0;
            const restored = ba.readObject().$Bgpayload;
            if (cls.axIsType(restored) && restored.position === 0 && restored.length === payload.length &&
                restored.getBytes().every((byte, index) => byte === payload.getBytes()[index])) {
                preservedAmfPayloads++;
            }
            message.$Bgpayload = null;
            try {
                ba.clear(); ba.writeObject(message); amfWithNullPayloadBytes += ba.length;
                // These payloads are <64 bytes: marker + one-byte U29 length + data.
                if (payload.length >= 64) throw new Error('Binary AMF size estimate requires short payloads');
                estimatedBinaryAmfBytes += ba.length - 1 + 2 + payload.length;
            } finally { message.$Bgpayload = payload; }
        }
        return {
            actualJsonBytes: byteLength(json), projectedJsonBytes: byteLength(projection),
            jsonFirst: JSON.parse(json[0]), projectedJsonFirst: JSON.parse(projection[0]),
            actualAmfBytes, amfWithNullPayloadBytes, estimatedBinaryAmfBytes, amfFirst, preservedAmfPayloads,
            decodedPayload: { isByteArray: cls.axIsType(decoded), keys: Object.keys(decoded || {}) }
        };
    })()`);
    await evaluate('delete window.__benchmarkProfile');
    const browser = await send('Browser.getVersion');
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ url, browser, phases, payloads, exceptions }, null, 2));
    for (const [name, group] of Object.entries(phases)) {
        if (!/^compiled_(serialize|deserialize)/.test(name)) continue;
        console.log(`${name}: ${group.sampledMs.toFixed(1)} sampled ms`);
        for (const [method, ms] of Object.entries(group.selfMs).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
            console.log(`  ${ms.toFixed(1)} ms ${method}`);
        }
    }
    console.log(JSON.stringify({ ...payloads, jsonFirst: undefined, projectedJsonFirst: undefined, amfFirst: undefined }, null, 2));
    if (exceptions.length) throw new Error(`${exceptions.length} browser exceptions; inspect report.json`);
    console.log(`Saved profile, timings, and payload report to ${output}`);
} finally {
    ws.close();
}
