# Pixi renderer experiments

The branch contains a frozen-frame comparison and an experimental live bridge.
Neither replaces the normal player bundle or changes its loader settings.
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

This uses private APIs from both engines. Fractional-size alignment differences
remain in the shared adapter: the 835×478 Battleon fixture had about 16.6% of
pixels differing over 3/255 (mean RGB error about 4.15), also reproduced with the
frozen adapter at that size. The previous 945×541 comparison below is not a
universal accuracy result. Server login, combat and every possible SWF effect
have not been automated or exhaustively validated.

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
