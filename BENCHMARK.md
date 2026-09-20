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
performance guarantee.

The subsequent storage refactor gives native `flash.utils.ByteArray` ownership of
its cached memory view. Buffer replacement updates a stable storage object, while
each application domain keeps a stable binding that follows reassignment. Generated
memory instructions resolve the binding once per invocation and access its current
view, so growth and rebinding remain visible between instructions without repeated
buffer comparisons. `ApplicationDomain` now uses the actual AVM2 ByteArray type.

The native ByteArray also zeroes truncated/newly exposed storage on explicit length
changes and clear. It retains capacity; normal scalar writes continue using the
existing direct write routines. This fixes stale bytes after shrink/regrow and in
write gaps, without adding a zero-fill step before each scalar write.

Three unprofiled Chrome runs before/after this refactor gave these totals in ms:

| Path | Before | After | Median before → after |
| --- | --- | --- | --- |
| AS3PB ByteArray | 710, 699, 711 | 740, 748, 715 | 710 → 740 |
| AS3PB memory | 1238, 1231, 1288 | 1191, 1260, 1299 | 1238 → 1260 |

These small samples show no demonstrated speedup from the storage refactor. It
improves ownership and correctness; the additional zero-fill work can add cost.
Further performance changes need profiling of the generated codec and VM calls.

## Focused checks

```sh
node scripts/check-benchmark-runtime.cjs
```

Checks the compressed fixture against an independently decoded payload hash, native
ByteArray zero-fill behavior, storage/view identity, buffer growth/replacement, and
shared storage across domains. It also executes all ten generated memory opcodes
across growth/rebinding, checking unsigned loads and preservation of address aliases.
Mouse-event checks cover individual and combined button masks without importing a
runtime object for AwayJS's erased `MouseButtons` const enum.
For the full integration check, open the benchmark and wait for **Done.**
