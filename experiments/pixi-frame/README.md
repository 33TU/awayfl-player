# Pixi renderer experiments

The branch contains a frozen-frame comparison, a live bridge, and a direct
display-list prototype. These experiments do not replace the normal player bundle
or change its loader settings.
PixiJS is pinned to 8.21.0 in this package's own lockfile.

From this directory:

```sh
npm ci
npm run build
```

With the existing Hono proxy running, open:

https://localhost:4433/game/gamefiles/pixi-benchmark/play.html

The live page starts Pixi after AwayFL loads. Log in and play inside the embedded
player. **Use AwayFL** switches rendering back without reconnecting; **Enable
Pixi** switches again. `?renderScale=1.5&fps=1` is the default; the normal loader
parameters are forwarded. `?autostart=0` waits for an explicit button click.

Pixi now owns the final scene drawing and top-level blend composition. The
preparation pass suppresses AwayFL's scene draw calls, scene clears, backdrop
copies and top-level composites. It preserves their projection setup so the
captured geometry does not shift. Blur, glow and drop-shadow GPU passes render through Pixi. Supported cached-layer
source meshes, nested cache quads and offscreen mask geometry now also draw
through Pixi's WebGL encoder. AwayFL still allocates targets and handles clears,
stencil setup, other filters and nested blend composition.

The live bridge now reads ordinary triangle meshes and strokes directly from
AwayFL's CPU geometry, including embedded text geometry, UVs, color transforms,
mask geometry and indexed draw ranges. The same adapter now supports cached
layer materials and their texture quads. These meshes skip AwayFL material
activation, vertex uploads and draw-call capture. CPU buffer invalidation updates
cached geometry; unchanged uniforms and cached sprite frames are retained.

AwayFL still schedules filter passes, allocates their temporary images and
computes padding; Pixi submits supported blur/glow/shadow passes. The bridge also
still uses AwayFL scene traversal and projection setup. Unsupported materials, animators and
cold shader programs use the capture path. This is an intermediate backend
migration, not a fully independent Pixi renderer or a guaranteed 24 FPS result.

The bridge borrows GPU textures (including persistent isolated blend sources)
in the shared WebGL 2 context and snapshots temporary blend sources with GPU
copies. Direct geometry needs no GPU buffer readbacks. The compatibility path
may download existing buffers once; live rendering does not read back pixels.
AwayFL keeps input, ActionScript, timelines and networking. Pixi's input listeners
are disabled. WebGL state and hooks are restored when switching back or after a
capture failure, including unbinding an interrupted AwayFL vertex array before
fallback. Stopping Pixi does not destroy AwayFL's graphics context.

Before final scene rendering, the bridge restores stencil writes and the zero
clear value that Pixi expects. AwayFL leaves stencil writes disabled after mask
tests; carrying that state into Pixi hides masked portraits, bars and lists.
Reusable filter shaders release their borrowed inputs after each pass. Texture
cleanup waits for remaining Pixi bind groups to release their sources, and
shutdown releases those bindings before destroying the borrowed wrappers.

Small source-encoder and blur/shadow passes save only the texture slots their
shaders can touch (consecutive slots from zero). Full renderer transitions still
preserve all slots. Shader identity lookup also reuses the original GLSL strings
instead of concatenating and hashing both sources for each mesh every frame.
In the instrumented, paused Battleon fixture this reduced texture binds from
7,071 to 1,744 per frame and active-texture switches from 6,072 to 742, with the
same draw count. Median render completion time was 174.0 ms before and 150.55 ms
after on SwiftShader with profiling enabled. See `state-scope-profile.json`;
these ten-frame, separate-load measurements are not Brave hardware FPS or a
guaranteed speedup in a live room. Thousands of individual draws and the remaining
preparation work still limit this experimental bridge.

The direct adapter also caches geometry layouts per elements/program/draw range.
It checks buffer content revisions, backing-storage identity, attribute views,
offsets, dimensions and strides before reusing expanded geometry. Reading the CPU
buffer still materializes pending layout changes and resets its dirty flag;
vertex and index edits therefore invalidate the cached result. Cumulative
`pixiLive.stats.direct.geometryHits`/`geometryMisses` expose reuse.

Live rendering checks WebGL errors at startup and context loss each frame. To
enable the synchronous error query on every frame while diagnosing a problem,
restart with `pixiLiveControls.enable({ validateGL: true })` after stopping Pixi.
Frozen capture and browser regression checks retain explicit error checks.
The geometry-cache/startup-only-query changes matched all RGBA pixels in an
old/new/new/old comparison on the same paused Battleon scene. Median completion
time was 80.95 ms before and 75.15 ms after; preparation was 60.5 ms versus
52.1 ms (`geometry-cache-profile.json`). These software-GPU fixture measurements
do not establish the bottleneck or FPS gain in a logged-in Brave session.

This uses private APIs from both engines. Fractional-size alignment differences
remain in the shared adapter: the 835×478 Battleon fixture had about 16.6% of
pixels differing over 3/255 (mean RGB error about 4.15), also reproduced with the
frozen adapter at that size. The previous 945×541 comparison below is not a
universal accuracy result. Server login, combat and every possible SWF effect
have not been automated or exhaustively validated.

## Direct display-list prototype

Branch: `experiment/pixi-display-list`. Build with the same `npm run build`.

https://localhost:4433/game/gamefiles/pixi-benchmark/play.html?backend=display-list&renderScale=0&fps=1

This opts into a separate Pixi WebGL canvas/context. The backend walks AwayFL's
runtime display objects and builds retained Pixi containers and meshes directly.
It does **not** call AwayFL's root renderer or capture its render commands. SWF
loading, tessellation, text layout, ActionScript, timelines and input still use
AwayFL. Runtime operations such as `BitmapData.draw()` still use native offscreen
renderers; this is not complete removal of AwayFL's graphics implementation.

Ordinary triangle meshes batch through Pixi. Repeated instances share a retained
`MeshGeometry` when their source elements, drawing range, UV mapping and shader
layout match. Transforms, colors and textures remain per-instance; moving,
rotating or scaling a shape does not rebuild its geometry. A source edit updates
shared geometry once, while a new drawing on one instance gets separate geometry.
Reference counts keep surviving copies valid when another instance is removed;
unused geometry is freed after rendering. CPU bitmap uploads are also cached by
asset revisions. This is mesh sharing, not a conversion to `GraphicsContext`. Embedded text, UV transforms,
linear/radial gradient atlases, color transforms, display-list changes, script and
timeline masks, and scroll rectangles have initial implementations. Bitmap edits
are observed without clearing AwayFL's pending upload flags, allowing a clean
switch back. The overlay passes mouse input through to the original player.

The direct backend uses Pixi filter shaders (`pixi-filters` 6.1.5), with no custom
Flash glow/shadow shaders:

| Flash effect | Pixi equivalent |
| --- | --- |
| Strong narrow outer glow, or strong narrow zero-offset shadow (AQW names/chat) | `OutlineFilter` |
| Other glows | `GlowFilter` |
| Drop shadow | `DropShadowFilter` tint/composite with native Gaussian `BlurFilter` |
| Inner shadow | Inner `GlowFilter` approximation |
| Blur | `BlurFilter` |
| Bevel | `BevelFilter` |
| Color matrix | `ColorMatrixFilter` (byte offsets normalized to 0–1) |

Effects favor visual similarity over Flash pixel parity. Glow/outline sampling
quality is 0.1, glow radius is capped at 32 render pixels, and blur/shadow quality
is capped at two passes. Strength is bounded at 16; high-strength narrow glows
become crisp outlines. Glow radii are circular, inner shadows lose their direction,
shadow knockout uses Pixi's shadow-only mode, and bevel type/knockout/blur have no
exact mapping. Filter sizes follow display scale. Broad Gaussian blurs use a
nine-sample kernel on a smaller target, with scene-space padding; their sample
spacing is derived from the blur width to avoid repeated silhouettes. Drop shadows
use the same Gaussian approach on a separate smaller target; the original image
is composited at full resolution to keep logos and text sharp. Other filter sizes
use quarter-pixel rounding. Overlay, darken, lighten and difference groups use
Pixi advanced blend filters; hard-light uses the existing Flash blend filter.
Unchanged parameters reuse filters. A changed glow radius recreates the filter,
because Pixi compiles its WebGL sampling radius into the shader.

Geometry is already shared and retained across frames (`geometryEntries`,
`geometryUsers`, and `geometryBuilds` in `pixiLive.stats`). The direct backend does
not yet flatten display groups with `cacheAsTexture`. It synchronizes the display
list each tick, but reuses the completed canvas when drawing inputs are unchanged.
Text/geometry, bitmap pixels, transforms, colors, masks, child order, filters and
resizing invalidate that frame. This saves idle-screen rendering; an animated
scene still draws the full scene. Subtree texture caching remains separate work.
`pixiLive.inspectText("name")` is a read-only diagnostic of matching non-input
text fields, their colors, textures and ancestor filters.

**Compatibility is incomplete.** GPU-only `BitmapData` images are skipped and
reported as `gpu-bitmap`; some game backgrounds therefore disappear. Other filter
kinds are still omitted and reported. Strokes and isolated blend groups are
approximations. Detached masks, 3D transforms and animated materials need further
work. Cache-as-bitmap hints do not yet create retained Pixi render textures.
Do not compare FPS with the working bridge or Ruffle as though output were equivalent.

`pixiLive.stats` reports `mode: "display-list"`, `syncMs`, `pixiMs`, mesh counts,
cumulative `geometryBuilds`/`textureUploads`, and per-frame `unsupported` counts.
`drawnFrames` and `reusedFrames` distinguish actual Pixi draws from unchanged ticks;
`pixiMs` is zero for reused frames.
`geometryEntries` counts retained unique geometry objects, `geometryUsers` counts
the retained meshes using them, and cumulative `geometryShares` counts acquisitions
that reused geometry already held by another mesh. Retention includes briefly
retired and hidden records, so users need not equal the current visible mesh count.
Timings are CPU synchronization/submission times, not GPU completion times. The
header shows the measured frame rate. Omit `backend=display-list` to use the
existing bridge, or click **Use AwayFL** to switch to the native renderer.

Validation:

```sh
npm run check:display-data
npm run check:display-geometry
npm run check:display-list
```

The browser check needs disposable Chrome on CDP port 9234. It opens its own tab,
never logs in, and checks input, retained resources, pixel output after movement,
redrawing, visibility, masks, bitmap edits, resize and stop/restart. Copies are
checked for geometry sharing, transform reuse, independent edits and removal.
The geometry unit check covers ranges, UV/layout variants, in-place source edits,
tracker retirement and last-user cleanup. The browser check also checks
glow/shadow effects, bevel, blur, color-matrix edits and embedded text outlines
after text changes and resize,
and rejects shader-link errors and destroyed-texture warnings. It replaces
AwayFL's root render function with a throwing stub during the direct-path tests.
It also loads the offline Battleon fixture and exposes its original vector
background, since the fixture normally rasterizes that background using native
`BitmapData.draw()`. GPU bitmap skipping is separately asserted. This validates
a first independent scene path, not Flash visual parity or gameplay performance.

## Frozen comparison

https://localhost:4433/game/gamefiles/pixi-benchmark/index.html

1. Wait for the embedded AwayFL login screen.
2. Choose **Load Battleon fixture (no login)**, or manually enter a room in the
   embedded player. The fixture includes map artwork/NPCs, not server players.
3. Choose **Capture & compare**. This pauses the embedded player, captures one
   frame and constructs a separate Pixi WebGL scene.
4. Inspect the reference, replay and amplified difference image.
5. Choose **Measure both renderers**. Choose **Resume AwayFL** afterwards.

The build writes only to the local proxy's `static/game/gamefiles/pixi-benchmark`
folder. It does not rebuild or overwrite AwayFL's Main.js. The proxy's static
folder is outside this Git worktree; all sources are kept here.

## What is being compared

The adapter captures the actual ordered scene submissions, vertex attributes,
material shaders/uniforms and source textures from AwayFL's WebGL 2 context.
Uncached geometry remains geometry. The original material shader is retained,
with its final projection adapted to Pixi's render targets. Pixi controls mesh
submission, stencil masks and advanced blends.

Existing cached images, including filtered source images, are reused as frozen
fixtures. Overlay inputs contain the isolated source, not the composed
background. This corresponds to a warm source cache and intentionally does not
measure rebuilding filters or tessellating changing geometry. Pixi custom
material meshes are not automatically batched; this is not a benchmark of an
optimized Pixi-native vector adapter.

Capture/readback and shader/resource creation are excluded from timings. Each
backend renders the same frozen state ten times after two warm-up renders.
`gl.finish()` includes GPU completion in each render duration. These are
**render-only completion times, not live game FPS**. The test excludes
ActionScript, animation, display-list updates, source-cache invalidation,
networking and asset loading. The normal player is paused during measurement.

Pixel error is reported separately. The report marks timings non-comparable
when pixels differ; visual agreement and coverage need review before inferring
that one equivalent renderer is faster. WebGL antialiasing/compositing can
produce edge differences even with identical geometry. Unsupported capture
paths fail explicitly instead of silently omitting geometry.

No credentials, captured pixels or benchmark reports are uploaded. Capture
hooks are restored in `finally`; Resume restores the player's prior pause state.
Reloading the experiment starts a fresh embedded player.

## Fixture limitations

The no-login fixture supplies a minimal host for the exported Battleon map and
rasterizes its static background as the game does. It can emit map/NPC script
errors for missing game session state. It is a rendering fixture, not a complete
simulation of joining Battleon; use an actual room capture for the player and
combat effects you care about. The login scene remains behind the map fixture.

Capture uses private AwayFL rendering APIs and currently requires WebGL 2.
Native blend modes outside the adapter's supported set fail explicitly. A Pixi
WebGPU backend, replacing AwayFL's remaining preparation/filter scheduling and native
vector batching are future work.

## Live browser checks

With a disposable Chrome running on debugging port 9234, run `npm run check:live`
(Node 22+). `CDP_URL` overrides the debugger URL. The script creates and closes
its own page, types a probe into the username field, loads the no-login Battleon
fixture, compares direct geometry, Pixi filter passes and cached-source drawing against
the previous capture-based Pixi output with AwayFL filters at login and in
Battleon (also after resizing), checks direct coverage, resizes twice,
checks zero live pixel readbacks, switches renderers,
forces cached layers to rebuild, injects both capture and source-draw failures,
checks restoration of hooks, then restarts Pixi. It also
compares 17 isolated filter fixtures, including cropped rectangles and in-place
filtering, and resumes the live renderer afterwards.
It also checks nested masks with stencil writes deliberately disabled, GL state
restoration, filter reuse after 125 idle frames, and texture cleanup with a live
shader binding. Destruction warnings fail the check; native texture ownership
must survive renderer shutdown.
It never submits login or game chat. The local test uses SwiftShader; timing
figures from it are not representative of hardware rendering in Brave.

## Initial local validation

See `smoke-result.json` for the software-WebGL (SwiftShader) run at 945×541.
Login and Battleon capture, measurement, repeated capture and restoring the
original player pause state/draw hooks passed, with no remaining WebGL error.
Pixel differences were unchanged after measurement. The Battleon fixture used
2,483 mesh draws, 546 cached images, 140 advanced-blend layers and 92 masked
commands; 0.546% of pixels differed by more than 3/255 in an RGB channel.

In that run, median completion times were 26.1 ms for AwayFL and 4.6 ms for Pixi.
Those software-renderer results are exploratory, not an Intel GPU or live-game
speedup claim. Pixel differences and the warm-cache-only scope still apply.

## Direct adapter validation

Run `npm run check:direct` for CPU-only tests of indexed subranges, interleaved
UVs, geometry reuse, vertex/index invalidation, unsupported animator fallback and
hook cleanup. Run `npm run check:live` for the browser integration checks.

The original direct-adapter check matched the previous preparation/capture bridge
exactly at login, in Battleon and after resizing. The current
`live-smoke-result.json` expands that check to include Pixi filters and cached
source drawing: Battleon
still matched exactly, with at most 1/255 RGB channel differences at login and
after resizing. The warm Battleon frame used about 2,500 direct mesh submissions
(including masks), no compatibility mesh fallbacks and no captured scene draws.
CPU geometry also loaded without GPU buffer readbacks. This checks migration
regressions, not accuracy against Flash or Ruffle; both share the pre-existing
visual limitations above. `liveReadbacks` excludes the test's explicit pixel
comparisons.

`pixiLive.stats.preparation` reports `directMeshes`, `directCaches`,
`directFallbacks`, actual AwayFL offscreen draws and captured scene draws
(`skippedSceneDraws`). For debugging, select the previous bridge with
`pixiLiveControls.stop(); await pixiLiveControls.enable({directScene:false})`.
Calling `enable()` after stopping selects the direct adapter again.
`{prepareOnly:false}` retains the older double-render reference for diagnosis.

Median completion timings include preparation, Pixi submission and `gl.finish()`
for a paused, warmed scene on SwiftShader. They are not live gameplay FPS or a
hardware GPU speedup claim. Renderer independence still requires moving target allocation, clears, stencil
setup, filter scheduling and nested blend composition to Pixi, and removing the
remaining AwayFL traversal and shared-context machinery.

## Pixi filter passes

`filter-passes.mjs` moves blur, glow and drop-shadow GPU draws to Pixi meshes,
borrowing the existing source/destination textures in the shared context. It
preserves the existing filter equations and quality settings rather than
substituting the community GlowFilter's different algorithm. This includes
inner, knockout, hideObject, colour/alpha/strength and directional shadows.
No CPU pixel readback or duplicate AwayFL filter draw occurs in the live path.
Multisampled destinations and other filter kinds keep their AwayFL path.

The isolated tests in `check-filter-browser.mjs` compare RGBA pixels against
AwayFL on an asymmetric, translucent, non-square fixture. Their GPU readbacks
are test-only. Scene comparisons allow one channel value of rounding difference
(1/255); isolated filter cases require exact agreement. These establish migration
compatibility, not independent Flash/Ruffle correctness. Shader programs and
quad geometry are reused, but shared-context state restoration still happens
per pass. This is not a demonstrated performance improvement.

`pixiLive.stats.filters` counts cumulative Pixi blur/shadow passes;
`pixiLive.stats.preparation.pixiFilterPasses` counts them in the latest frame.
To compare the previous filter path while retaining Pixi scene rendering:

```js
pixiLiveControls.stop();
await pixiLiveControls.enable({ pixiFilters: false });
```

Stop and call `enable()` with no options to restore Pixi filtering.

## Cached source drawing

The source adapter submits cached-layer triangles, strokes, text and mask
geometry through Pixi, along with nested cache texture quads. It keeps the
original clip-space projection and draws into the currently bound target,
including its multisampled colour/depth/stencil buffers. Texture allocation,
clears and stencil configuration still belong to AwayFL at this stage; these
are shared targets, not yet independently owned Pixi render textures.

Contiguous supported draws are submitted together, with WebGL state restored
between batches. Mask changes and unsupported materials flush the pending batch
before native processing continues. Shader/geometry resources persist across
frames and unused source meshes expire after 120 frames. No source pixels are
copied to the CPU. Unsupported or cold materials retain the native draw path.

The local Battleon check matched the previous output exactly both when warm and
when forcing cache rebuilds. A warm frame moved 1,014 source mesh submissions
(including 291 mask meshes) to Pixi, leaving four AwayFL GPU draws. The forced
rebuild moved 1,932 submissions, including 40 nested cache quads; copy/composite
passes still accounted for 556 native draws. These figures describe the fixture,
not every game scene. Render-only SwiftShader timings are not hardware FPS.
In the recorded run, forcing every cache to rebuild took a median 221.1 ms with
Pixi source drawing versus 115.3 ms with native source drawing (both using Pixi
scene rendering and filters). Warm-frame results were mixed. This migration
preserves output but does not establish a speedup; per-batch shared-context work
remains an optimization target.

`pixiLive.stats.preparation` now includes `sourceMeshes`, `sourceCacheQuads`,
`sourceMaskMeshes`, `sourceBatches`, and `sourceFallbacks`. To compare with the
previous source path while retaining Pixi scene drawing and filters:

```js
pixiLiveControls.stop();
await pixiLiveControls.enable({ cachedLayers: false });
```

Stopping and enabling without options restores Pixi source drawing. The normal
AwayFL loader is unchanged.

## Blend failures and timing snapshots

Flash's `hardlight` name maps to Pixi's `hard-light`. Its blend shader evaluates
straight RGB values from premultiplied inputs, then composites source and
backdrop coverage. The browser check exercises the actual ActionScript setter
with opaque and translucent fills, comparing pixels against the hard-light
formula (within one 8-bit channel value). It also checks that stopping the
renderer releases the advanced-filter texture bindings without warnings.

There is a separate known upstream discrepancy: a sprite with object `alpha`
0.5 can already have alpha 0.25 in AwayFL's isolated source texture, even with
Pixi disabled. This adapter does not compensate for that source-rendering issue.

`pixiLive.stats.active` becomes false on stop or fallback. In that case the frame
timings remain the last successful Pixi frame, and `lastError` reports why it
stopped. They do not measure the renderer currently displaying the game.

The reported Battleon frame (1440 × 825) had 156.5 ms preparation and 52.1 ms
Pixi composition before a hardlight fallback. Its cumulative geometry cache hit
rate was about 98%; 8,486 prepared meshes and 288 filter passes in that frame
remain substantial work. Fixing the fallback does not establish a speedup or
24 FPS. Reducing per-mesh preparation and draw submissions remains necessary.

## Uniform preparation cost

Direct recipes now snapshot shader constants into `Float32Array`s. Previously,
all meshes converted those floats into JavaScript arrays, followed by conversion
back into floats in Pixi. The snapshots still own their data: subsequent draws
may reuse and mutate the same AwayFL shader. The retained mesh updater supports
both typed snapshots and ordinary arrays from the compatibility capture path.
Recipe objects also use a fixed set of fields instead of spreading geometry and
then adding fields for every draw.

The same paused Battleon fixture, measured old/new/new/old against `dc031c3`,
reduced median render time from 99.4 ms to 72.45 ms. Median preparation went from
65.45 ms to 53.65 ms and Pixi composition from 26.0 ms to 19.1 ms. All four runs
produced identical pixels. See `uniform-preparation-profile.json` for samples.
This uses headless Chrome/SwiftShader at 641 × 367 with about 2,500 scene meshes;
it is not the user's Brave/GPU scene or a claim of 24 FPS. At that point there was still one mesh submission per recipe; the batching
work below addresses those submissions.

## Mesh batching

Live rendering now batches adjacent compatible meshes in both the scene and
cached-layer source passes. Each vertex carries a draw index; the vertex shader
selects that mesh's packed `vc` constants. Fragment shaders and their constants
stay unchanged. Batches share shader, texture/sampler state, blend/raster state,
viewport and non-vertex uniforms. This keeps transforms independent without
introducing a per-pixel constant lookup. Geometry is concatenated once and reused
until its members or vertex data change; uniforms are fresh snapshots per pass.

Batches preserve order and stop at root masks, cached images, state changes and
source-pass boundaries. They contain at most 16 meshes or 65,536 vertices, and
respect the device's vertex uniform/attribute limits. Small batches use smaller
uniform arrays. Unrecognized shaders retain individual draws. Masked root
commands and filter passes are not combined by this batcher.

The paused Battleon comparison against `57e8696` reduced total GL draws from
4,786 to 2,215 per frame, with identical pixels. Median render time fell from
58.4 ms to 51.65 ms; Pixi composition from 15.9 ms to 12.95 ms. These are
render-only headless Chrome/SwiftShader results at 641 × 367, not hardware FPS
for a logged-in Brave session. Raw samples are in `mesh-batching-profile.json`.
The larger preparation cost remains; this does not establish 24 FPS.

`pixiLive.stats.scene.batching` reports the scene/source mesh inputs, batch
outputs and merged submissions for the latest frame. `geometryBuilds` is
cumulative. `scene.timings` separates scene batch construction, retained-object
updates and Pixi submission time. For an A/B comparison in the same room:

```js
pixiLiveControls.stop();
await pixiLiveControls.enable({ batching: false });
```

Stop and enable with no options to restore batching. `npm run check:batches`
checks limits, order/state boundaries, geometry edits and constant isolation.
`npm run check:live` compares batched output against the unbatched renderer,
including moved meshes, color changes, masks, resize and rebuilt cache sources.
