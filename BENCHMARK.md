# AS3PB benchmark

From this directory:

```sh
npm install
npm run server:dev -- --port 8080 --host 127.0.0.1
```

Open http://127.0.0.1:8080/as3pb-bench.html. The benchmark starts automatically;
use **Run Benchmark** to repeat it. Completion is indicated by **Done.**

Keep the sibling `../avm2`, `../playerglobal`, and `../swf-loader` checkouts.
Webpack uses the first two directly from source. The startup/build scripts compile
the local SWF loader with TypeScript so its imported const enums are inlined.
Dependencies are resolved from this player's `node_modules`. Restart the server
after editing the SWF loader to recompile it.

`src/assets/as3pb-bench.swf` is now an exact copy of the original compressed
`../as3pb-bench.swf`. The loader fix preserves the full SWF header for the LZMA
decoder; previously it incorrectly removed eight bytes. It also closes the complete
LZMA input to flush the final decoded bytes. The original is unchanged.

Local fixes add FINDDEF support, enable domain-memory instructions, preserve
address registers during memory loads, refresh memory views when buffers grow,
and correct AMF3 vector encoding. The benchmark disables the JIT's real-this
optimization because its bytecode reuses local register 0.

Validated in headless Chrome: AS3PB bytes, AS3PB memory, AMF3, and JSON completed
without uncaught exceptions, including the SWF's memory correctness checks.
Timing results describe this patched runtime and vary by browser and machine.
Existing dependency/export warnings remain in the development console.

## Performance investigation

Repeated console logging in the `ApplicationDomain.domainMemory` getter dominated
the initial profile. Removing getter/setter logging reduced AS3PB memory totals
from 8052 ms to 1342 ms in two runs under the same headless Chrome profiling
setup (4056/3996 ms encode/decode before; 684/658 ms after). ByteArray totals were
756 ms and 792 ms respectively. This is an initial comparison, not a statistical
performance guarantee. Domain-memory operations still refresh their view to handle
buffer replacement/growth correctly; further optimization remains possible.

## Focused checks

```sh
node scripts/check-benchmark-runtime.cjs
```

Checks the compressed fixture against an independently decoded payload hash and
exercises initial memory binding, view reuse, buffer growth, and rebinding.
For the full integration check, open the benchmark and wait for **Done.**
