# AS3PB benchmark

From this directory:

```sh
npm install
npm run server:dev -- --port 8080 --host 127.0.0.1
```

Open http://127.0.0.1:8080/as3pb-bench.html. The benchmark starts automatically;
use **Run Benchmark** to repeat it. Completion is indicated by **Done.**

Keep the sibling `../avm2`, `../playerglobal`, and `../swf-loader` checkouts.
Rspack uses the first two directly from source.
The startup/build scripts compile the local SWF loader with TypeScript so its imported const enums are inlined.
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

## Rspack builds

`npm run build:dev`, `npm run build:prod`, and `npm run server:dev` use Rspack.
The parent workspace's `just prod` recipe therefore uses Rspack too. Run
`npm install` after updating this branch. Building requires Node.js
`^20.19.0 || >=22.12.0`; these measurements used Node 24.13.1.

`rspack.config.js` configures the game templates, asset copying, local runtime
aliases, per-game production folders, and development server. It uses
SWC for TypeScript and minification, with ES5/loose class transforms matching the
runtime's callable constructors and assignment-style fields. The SWF loader is
still compiled by TypeScript first to inline its external const enums. Source
transpilation does not replace type checking.

Rspack 2 treats missing exports as errors by default. Its configuration restores
Webpack's `exportsPresence: 'auto'` behavior, leaving the existing five AVM2 type
reexport warnings and GraphicsEndFill mismatch visible. The migration does not
fix or hide those upstream issues. See the official
[Webpack migration guide](https://www.rspack.dev/guide/migration/webpack) and
[Rspack 2 export-checking defaults](https://www.rspack.dev/guide/migration/rspack_1.x).

Three alternating production builds of each bundler gave the following seconds:

| Bundler | Full command, three runs | Median full command | Median bundling |
| --- | --- | ---: | ---: |
| Webpack | 18.41, 17.66, 18.71 | 18.41 | 15.16 |
| Rspack | 4.15, 4.16, 4.29 | 4.16 | 1.39 |

The full command includes npm startup, output cleanup, and the SWF-loader
TypeScript build. Bundling is the duration reported by each compiler. Each run
started a fresh process; these are local measurements with warm OS caches, not
cold-machine or incremental-build timings. Rspack 2.2.6 reduced the full median
from 18.41 s to 4.16 s (4.4x faster), and bundling from 15.16 s to 1.39 s (10.9x).
The shared loader build accounts for much of the remaining startup cost.

The minified Main.js grew from 3,207,104 to 3,246,572 bytes (1.2%). Rspack emits
`Main.js.LICENSE.txt` beside each game's bundle. Assets and per-game HTML match
the Webpack output; root-index formatting and JavaScript minification differ.
These build-time improvements do not establish faster SWF execution.

A separate three-pair alternating runtime comparison used one warmup and one
unprofiled measured invocation per fresh production page in Chrome 153.0.8010.52:

| Codec | Webpack totals, ms | Rspack totals, ms | Median Webpack → Rspack |
| --- | --- | --- | --- |
| AS3PB bytes | 631, 618, 617 | 623, 671, 648 | 618 → 648 |
| AS3PB memory | 974, 951, 1065 | 969, 1035, 1079 | 974 → 1035 |
| AMF3 | 3270, 3263, 3493 | 3405, 3439, 3351 | 3270 → 3405 |
| JSON | 1649, 1674, 1731 | 1700, 1825, 1914 | 1674 → 1825 |

Median codec totals were 4–9% higher with the Rspack bundle in this small sample.
The faster build has a potential execution-time tradeoff. The sample is too
small for a general runtime performance claim; no SWF execution speedup is claimed.

Validation includes development-server and production browser runs through
`Done.`, with zero captured exceptions, 63,598 AMF3 bytes, and all 100 ByteArray
payloads preserved. The SWF's byte/cursor/round-trip assertions and the focused
runtime/slot-writer scripts pass. Editing the player entry or a sibling AVM2
source triggers a development rebuild. The pre-migration Webpack output was also
validated during comparison. The existing JSON discrepancy remains unchanged.

Webpack measurements above are historical migration results. The old pipeline
is preserved in Git history (before the Rspack migration); the current checkout
uses a single Rspack configuration. Run `npm run build:prod` from this directory
or `just prod` from the workspace root to build the production player.

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

Both differences were reproduced on the SWF's own freshly generated 100-message
fixture before the ByteArray correction below. These were **diagnostic
projections/estimates**, not runtime fixes:

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
At that point, the investigation had changed only diagnostic tooling and
documentation. The AMF3 ByteArray issue is now corrected as described below;
the JSON issue remains open.

### Ruffle reference and AMF3 ByteArray correction

Reviewed Ruffle at `1bc8bbf7829c0ce9f127a422045bf96a0814469c`:

- [AVM2 object conversion](https://github.com/ruffle-rs/ruffle/blob/1bc8bbf7829c0ce9f127a422045bf96a0814469c/core/src/avm2/amf.rs)
  maps ByteArrays to raw bytes and reconstructs native ByteArray objects.
- The binary encoder/decoder lives in its pinned `rust-flash-lso` dependency:
  [writer](https://github.com/ruffle-rs/rust-flash-lso/blob/61b717248aae853a4f5d8a103eba704268d286c8/flash-lso/src/amf3/write.rs),
  [reader](https://github.com/ruffle-rs/rust-flash-lso/blob/61b717248aae853a4f5d8a103eba704268d286c8/flash-lso/src/amf3/read.rs).
- Its [ByteArray regression output](https://github.com/ruffle-rs/ruffle/blob/1bc8bbf7829c0ce9f127a422045bf96a0814469c/tests/tests/swfs/avm2/bytearray_serialization/output.txt)
  provides an independent wire fixture used by the focused checks.

AwayFL now reads and writes the AMF3 ByteArray marker, unsigned length header, and
logical data bytes. Repeated occurrences share the existing AMF object-reference
table. Serialization preserves the source cursor, excludes spare capacity, and is
independent of endian settings. Decoding constructs a native ByteArray with cursor
zero. Empty values do not consume following AMF data; truncated data raises EOF.
U29 parsing now sign-extends only INTEGER values, keeping length/reference headers
unsigned, and writing accepts their full 29-bit range.

The actual browser benchmark now writes **63598 AMF3 bytes**. All **100 payloads**
survived a real `writeObject`/`readObject` round trip with their ByteArray type,
contents, and initial cursor intact. This matches the AIR size, although no AIR
binary dump was available for a full byte-for-byte comparison. JSON still writes
250528 bytes and its diagnostic projection remains 75048 bytes.

Validation: focused runtime checks including the Ruffle wire fixture in both
directions, shared/distinct buffer identity, empty values followed by more AMF data,
self-serialization, EOF, signed integers, and U29 length boundaries; AVM2 TypeScript
compilation; development webpack build; complete browser benchmark and payload
inspection without uncaught exceptions. The build retains its six existing warnings.

This fixes the benchmark's ByteArray defect, not all AMF3 gaps. AwayFL still needs
work on Dictionary, externalizable objects, and Date/XML reference handling.
Ruffle is a useful reference but its reviewed AVM2 conversion also has explicit
gaps for custom/externalizable values and weak Dictionary keys. No Rust runtime or
new dependency was added to the player.

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
AMF bytes, the decoded payload's type, and the number of all 100 payloads preserved
by an AMF3 round trip. It fails on captured browser exceptions.
Override `CDP_URL`, `BENCHMARK_URL`, or `OUTPUT_DIR` through environment variables.
Readable runtime method names in its summary require the development bundle.

## Property-access optimization

The JIT now creates a cached slot writer for static property names in methods that
contain domain-memory instructions. It remembers the receiver's resolved trait
table, mangled slot name, and coercion type. Repeated writes such as
`PackContext.position` avoid resolving that same trait on every byte while still
coercing every assigned value. A different trait table refreshes the cache;
accessors, constants, dynamic names, native overrides, Proxy/XML/Vector handling,
and external objects retain the original setter path. Type resolution and coercion
can re-enter AS3 without corrupting the outer assignment.

`Settings.CACHE_DOMAIN_MEMORY_WRITES` controls this optimization at compilation
time. It is deliberately limited to methods with memory instructions: the initial
experiment applying it to all methods slightly regressed the ByteArray path.
The cache is created once with the compiled function, not on each call.

Native ByteArray storage, scope lookup, and memory load/store semantics are
unchanged. A broader scope-cache experiment was left out because its benefit to
ByteArray timings was not consistent.

Validate the new paths with:

```sh
node scripts/check-slot-writer.cjs
node scripts/check-benchmark-runtime.cjs
```

The first check exercises the real slot writer, generic ASObject setter, and trait
lookup with small VM adapters. It covers coercion,
receiver changes, private namespaces, native overrides, accessors, readonly/method
errors, and reentrancy during coercion/type resolution.
The browser benchmark additionally checks encoded
bytes, decoded cursors, and round trips against its ByteArray codec.

Three alternating before/after production comparisons used the same SWF in Chrome
153.0.8010.47, with one warmup and one measured full invocation per fresh page.
The baseline was AVM2 `0b46bb8`. No profiler was active for these timings:

| Path | Before totals, ms | After totals, ms | Median before → after |
| --- | --- | --- | --- |
| AS3PB memory | 990, 994, 1030 | 929, 929, 928 | 994 → 929 |
| AS3PB ByteArray | 593, 657, 644 | 592, 592, 576 | 644 → 592 |
| AMF3 | 3116, 3235, 3123 | 3059, 3047, 3016 | 3123 → 3047 |
| JSON | 1601, 1594, 1602 | 1590, 1734, 1744 | 1601 → 1734 |

Memory time fell in every pair, with a 6.5% reduction in the median total. This is
a modest local improvement; it does not close the gap to AIR's 192 ms total.
ByteArray has no implementation change and its timings varied between experiments,
so no reliable storage-speed improvement is claimed. JSON was slower in two runs
and remains semantically incorrect; these results do not establish a universal
speedup. The complete four-codec elapsed sum fell in all three pairs, but three
samples are insufficient for a general performance guarantee.

All benchmark byte/cursor/round-trip checks completed without browser exceptions.
The focused runtime/slot-writer checks and AVM2 TypeScript compilation passed;
the production build retains the six existing export warnings. Rebuild with
`just prod` from the workspace root to try the change.

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
