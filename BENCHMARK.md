# AS3PB benchmark

From this directory:

```sh
npm install
npm run server:dev -- --port 8080 --host 127.0.0.1
```

Open http://127.0.0.1:8080/as3pb-bench.html. The benchmark starts automatically;
use **Run Benchmark** to repeat it. Completion is indicated by **Done.**

Keep the sibling `../avm2` and `../playerglobal` checkouts: webpack uses their
source directly for the runtime fixes required by this SWF. Dependencies are
resolved from this player's `node_modules`.

The original `../as3pb-bench.swf` uses LZMA compression that the player cannot
decode. `src/assets/as3pb-bench.swf` contains the same payload in uncompressed
FWS format. The original is unchanged.

Local fixes add FINDDEF support, enable domain-memory instructions, preserve
address registers during memory loads, refresh memory views when buffers grow,
and correct AMF3 vector encoding. The benchmark disables the JIT's real-this
optimization because its bytecode reuses local register 0.

Validated in headless Chrome: AS3PB bytes, AS3PB memory, AMF3, and JSON completed
without uncaught exceptions, including the SWF's memory correctness checks.
Timing results describe this patched runtime and vary by browser and machine.
Existing dependency/export warnings remain in the development console.
