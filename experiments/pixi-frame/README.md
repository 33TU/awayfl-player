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
captured geometry does not shift. Offscreen filters, cached source images and
nested effects still render through AwayFL.

This remains an experimental bridge. AwayFL still traverses the scene, activates
materials and uploads geometry for capture; Pixi then submits the final scene.
Removing duplicate GPU draws does not remove this CPU overhead or guarantee
24 FPS. The renderer toggle allows comparison on your own GPU.

The bridge reuses meshes, programs and uploaded geometry between frames. It
borrows GPU textures (including persistent isolated blend sources) in the shared
WebGL 2 context, snapshots temporary blend sources with GPU copies, and mirrors
buffer uploads. Buffers that existed before
activation may be downloaded once; live frames do not read back pixels. AwayFL
keeps input, ActionScript, timelines and networking. Pixi's input listeners are
disabled. WebGL state and hooks are restored when switching back or when a
capture fails, and stopping Pixi does not destroy AwayFL's graphics context.

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
WebGPU backend, replacing AwayFL's remaining preparation/filter passes and native
vector batching are future work.

## Live browser checks

With a disposable Chrome running on debugging port 9234, run `npm run check:live`
(Node 22+). `CDP_URL` overrides the debugger URL. The script creates and closes
its own page, types a probe into the username field, loads the no-login Battleon
fixture, compares the prepared and double-rendered Pixi output at login and in
Battleon (also after resizing), checks that AwayFL draws decrease, resizes twice,
checks zero live pixel readbacks, switches renderers,
injects a capture failure, checks restoration of hooks, then restarts Pixi.
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

## Composition optimization validation

`live-smoke-result.json` records the latest local browser check. Its pixel check
compares two Pixi frames of the same paused scene: the original double-render
reference and the new preparation-only path. This checks for regressions from
skipping AwayFL composition, not accuracy against Flash or Ruffle. The local run
had zero pixel differences at login, in Battleon and after resizing. Warm
Battleon preparation fell from 4,466 AwayFL GPU draws to 1,051, with 140
top-level composites skipped. Both paths
still share the adapter's pre-existing visual limitations above.

For debugging, `pixiLive.stats.preparation` reports actual AwayFL draws and
skipped scene draws/composites. The test-only reference is available through
`pixiLiveControls.stop(); await pixiLiveControls.enable({prepareOnly:false})`;
calling `enable()` after stopping selects the optimized path again. Median
completion timings include preparation, Pixi submission and `gl.finish()` for a
paused, warmed scene on SwiftShader; they are not live gameplay FPS.
