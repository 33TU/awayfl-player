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

## Warmed profile and AIR comparison (2026-09-20)

Profiling the second complete invocation in headless Chrome 153.0.8010.47, at a
250 microsecond sampling interval, identifies property dispatch as a major source
of the remaining memory-path overhead. The development bundle yielded:

| Codec phase | Sampled total, ms | Property writes / trait lookup | Scope lookup / cache access | Native Vector methods |
| --- | ---: | ---: | ---: | ---: |
| ByteArray serialize | 285 | 7 | 131 | 18 |
| Memory serialize | 595 | 190 | 151 | 12 |
| ByteArray deserialize | 393 | 134 | 51 | 38 |
| Memory deserialize | 506 | 181 | 65 | 39 |

These are sums of **self samples**, classified by codec ancestors, not individual
operation timings. Property/trait totals include `Context.setproperty`,
`ASObject.axSetProperty`, and `RuntimeTraits.getTrait`. Scope totals include
`Scope` methods and `Multiname.scope/value` accessors. Native Vector totals exclude
AS3 codec functions that iterate Vectors. GC samples without a codec ancestor and
harness setup/binding/copy work are outside these four rows. Sampled phase totals
therefore differ from the benchmark's displayed elapsed times.

An earlier warmed capture also showed the same serialization pattern: 205 ms in
property/trait helpers for memory versus 11 ms for ByteArray. The generated memory
code performs a generic `context.setproperty(...)` when updating a context's
`position`, alongside the direct `domainMemory.storage.view.setInt8(...)` store.
That setter resolves traits and coerces the value each time. Native ByteArray
methods advance their internal cursor directly. The current JIT fast setter is
limited to a recognized `this` receiver; it does not optimize these context
parameters. See `../avm2/lib/jit.ts` and `../avm2/lib/nat/ASObject.ts`.

Only about 0.9 ms of serialization self samples hit the domain-memory binding
getter in the second capture. This does not measure all binding cost or prove
memory loads/stores are free: DataView operations can be inlined into generated
functions. It does show that another binding/view redesign is not the first
optimization supported by these profiles. A useful next experiment is a guarded
fast path for statically known writable typed slots, preserving coercion, namespace,
accessor, and error behavior. Scope-cache work also merits investigation.

Production bundling helps but does not reverse the ordering. Three fresh page
loads per build, without profiling, produced these totals:

| Build | ByteArray totals, ms | Memory totals, ms | Median ByteArray / memory |
| --- | --- | --- | --- |
| Development | 713, 740, 735 | 1187, 1201, 1196 | 735 / 1196 |
| Production | 651, 588, 633 | 1040, 993, 1022 | 633 / 1022 |

These small sequential batches are diagnostic, not a statistical speedup claim.
The user's AIR totals were 452 ms and 192 ms respectively. No AIR execution was
performed in this investigation. Production builds use a different page path:

```sh
npm run build:prod
python3 -m http.server 8082 --bind 127.0.0.1 --directory bin
```

Open http://127.0.0.1:8082/as3pb-bench/index.html.

### Payload discrepancies

Both differences are reproducible on the SWF's own freshly generated 100-message
fixture. These are **diagnostic projections/estimates**, not runtime fixes:

| Format | Actual AwayFL bytes | Diagnostic result | User's AIR bytes |
| --- | ---: | ---: | ---: |
| AMF3 | 67908 | 63598, estimated with binary ByteArrays | 63598 |
| JSON | 250528 | 75048, public-value projection | 75048 |

`../avm2/lib/amf.ts` has no ByteArray read/write case despite declaring its marker.
The writer falls through to generic object serialization. After a real
`writeObject`/`readObject` round trip, the benchmark's payload is an ordinary object
with `length`, `position`, `objectEncoding`, and `endian`, and **its bytes are lost**.
The null-payload version totals 62508 bytes. Replacing each one-byte null with the
binary ByteArray marker, its short U29 length, and its 9 or 10 data bytes predicts
63598 bytes. This is consistent with Adobe's
[AMF3 specification, section 3.14](https://veovera.org/docs/legacy/amf3-file-format-spec.pdf).
It is not a byte-for-byte comparison against an AIR payload dump.

`../avm2/lib/nat/transformASValueToJS.ts` walks raw `Object.keys`, then removes the
first three characters of nonnumeric keys without restricting them to public
ActionScript names. This exports `constructorHasRun` as `structorHasRun`, includes
ByteArray capacity and numeric-Vector backing buffers, and bypasses the existing
ByteArray `toJSON()` method. It also misses public accessors such as `ticks.length`.
Projecting the fixture's public slots/accessors, numeric Vectors as arrays, and
ByteArray through its existing `toJSON()` produces exactly 75048 UTF-8 bytes.
Public-property traversal and `toJSON()` behavior are documented in the
[AIR JSON guide](https://airsdk.dev/docs/development/core-actionscript-classes/using-native-json-functionality).
The projection in the profiling script is specific to this fixture, not a general
JSON replacement. The harness already decodes only a subset of JSON fields.

Thus the current AMF3/JSON runs completing with `Done.` do not establish payload
correctness, and their timings should not yet be treated as equivalent AIR work.
The runtime corrections remain follow-up work; this investigation changes only
diagnostic tooling and documentation.

### Reproduce the investigation

Start the development server as above. In a separate terminal, start a dedicated
Chrome instance (the script navigates its first page):

```sh
google-chrome --headless=new --disable-dev-shm-usage --enable-unsafe-swiftshader \
  --remote-debugging-port=9222 --user-data-dir=/tmp/awayfl-profile-chrome about:blank
```

Then, using Node 22 or newer:

```sh
node scripts/profile-benchmark.mjs
```

The script warms up the SWF, profiles a second full run, and only then inspects
payloads. It restores the intercepted ByteArray method. It writes `warmup.txt`,
`profiled.txt`, `report.json`, and `benchmark.cpuprofile` under
`/tmp/awayfl-benchmark-profile`; import the latter into Chrome DevTools Performance.
The report includes browser version, per-phase self samples, representative JSON,
AMF bytes, and the decoded payload's type. It fails on captured browser exceptions.
Override `CDP_URL`, `BENCHMARK_URL`, or `OUTPUT_DIR` through environment variables.
Readable runtime method names in its summary require the development bundle.

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
