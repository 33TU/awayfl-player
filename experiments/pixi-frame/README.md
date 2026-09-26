# Pixi renderer experiments

The branch contains a frozen-frame comparison, a live bridge, and a direct
display-list prototype. These experiments do not replace the normal player bundle
or change its loader settings.
PixiJS is pinned to 8.21.0 in this package's own lockfile.

## Direct object ownership experiment

Branch: `experiment/pixi-direct-objects`.

https://localhost:4433/game/gamefiles/pixi-benchmark/play.html?backend=direct-objects&renderScale=0&fps=1

Each observed Flash display object owns a persistent Pixi container. Transform
and visibility invalidation updates that container immediately. Child insertion,
removal, reordering and reparenting update the Pixi hierarchy synchronously,
including timeline calls through the shared display-object methods. Moving or
reparenting an object preserves its Pixi identity. Hooks and ownership are
released when switching back to AwayFL; the normal display-list backend remains
available at `backend=display-list`.

Preparation is now incremental. Display-object changes mark the affected branch;
shared geometry and bitmap changes notify each object using that asset. Unchanged
subtrees retain their meshes, colors, masks and effect settings without a walk.
A fully unchanged frame skips preparation and reuses the completed canvas.
Direct-object transform notifications now preserve clean descendants when only
2D translation changes. Pixi propagates the parent's movement; inherited color,
linear transforms, stroke widths and filter scale stay unchanged. Rotation,
scale, 3D/combined invalidations, color changes and reparenting still invalidate
the affected subtree. Independently dirty children are still visited. Set
`reuseTranslations:false` when enabling the backend to compare full preparation.
`translationReuses` counts transform notifications taking this path. The browser
regression compares translated shapes, fixed-width strokes, filtered children,
text and masks against forced full preparation, and exercises simultaneous
geometry edits, scaling, rotation, color and visibility changes.

Ancestor color/transform changes and resizing refresh affected descendants.
Detached objects keep their resources briefly for reattachment, then release them.
Invalidations schedule these comparisons without advancing the visual revision.
Only actual paint, transform, visibility, hierarchy or effect changes invalidate
retained pictures. Repeated unchanged invalidations can therefore finish scenery
warmup and reuse both cached textures and the completed canvas.

Stable scenery branches now use Pixi's `cacheAsTexture`: after 24 unchanged
frames, eligible branches with at least 64 meshes become a retained texture.
Text, filters, masks and non-normal blends are excluded. Changes invalidate the
cache; transforms and resizing recalculate its resolution at the rendered scale.
The cache budget is 8 million backing texels in total and 4 million per group;
GPU memory also includes antialiasing and Pixi's texture-pool overhead. Hidden
or detached caches are released. Append `&cacheScenery=0` for a comparison.
`sceneryCaches`, `sceneryMeshesCached`, `sceneryPixels` and `sceneryBuilds` in
`pixiLive.stats` show the retained groups and their cost. Mesh counts are not
WebGL draw-call counts.
`sceneryCandidates`, `sceneryWarming` and `sceneryRejected` distinguish absent
eligible branches, stability warmup and size rejection. For individual candidates,
`pixiLive.inspectScenery()` reports mesh counts, stable frames and retained texels.
It also includes the most recent visual-change reason. Ancestor scale changes
invalidate scenery resolution even when the child's local matrix stays unchanged.

Pixi errors pause the game and keep Pixi selected. Initialization errors, render
exceptions and direct-backend context loss display an error; none automatically
resume AwayFL scene drawing. Reload to retry, or explicitly click **Use AwayFL**.
`stats.failed` identifies a paused render failure; `lastError` contains its reason.
The original rendering hook and prior pause state are restored on an explicit switch.

Flash vector meshes now share a Pixi batch even when they have color offsets,
radial gradients, atlas rectangles or analytic curve data. These per-mesh shader
values are packed into vertex attributes, preserving draw order, masks and blend
boundaries. `vectorBatchedMeshes` counts advanced meshes using this path;
`customMeshes` counts meshes that still require separate shader draws. Append
`&vectorBatching=0` to compare the previous rendering path.
When only existing meshes move or change color, the vector batcher uploads
their edited vertex ranges instead of the entire scene vertex buffer. Distant
ranges are sent separately; nearby edits (within 16 KiB) merge. The adapter
keeps at most eight uploads per buffer, preserving the largest gaps, and uses
one union when the planned ranges cover at least 75% of that union. This
bounds driver-call overhead while leaving unchanged middle vertices on the GPU.
Stop and re-enable with `{ sparseUploads: false }` to compare the previous
single-union path. Deferred ranges are tied to both the CPU revision and GPU
buffer identity; superseded, resized or recreated buffers use Pixi's ordinary
upload path. Hooks apply only to this renderer and are restored on stop.
Structural changes still rebuild and upload the complete affected batch. The
diagnostic `uploadBytes` measures the actual GL buffer traffic; the initial
allocation can be much larger than subsequent updates. The sparse-edit
regression moves two tiny objects at opposite ends of a dense buffer: uploads
fall from 1,585,056 to 1,056 bytes/frame with identical pixels, no batch
rebuilds, and unchanged draw/group counts. See `sparse-upload-profile.json`
for scope and an animated fixture sample. For a programmatic
comparison, stop Pixi and enable it with `{ partialUploads: false }`.
The moving-rectangle regression uploads 528 bytes instead of 394,198,112 bytes
per frame with identical final pixels. Its scope and raw measurements are in
`partial-upload-profile.json`; animated topology changes can still require full uploads.

Before repacking a retained mesh, the vector batcher now checks every packed
input against its previous draw: geometry buffers and revisions, transform,
color, UV matrix, texture slot, Flash shader parameters and target buffer/offset.
Pixi can request an update even when these values are unchanged (for example
when ancestor transform invalidation reaches a group). Such requests no longer
rewrite or upload its vertices. In-place data edits still require the normal
buffer revision update. Structural batch rebuilds discard these snapshots.
To compare, stop and enable with `{ skipUnchanged: false }`.
Profiles report `unchangedUpdates` and `packedUpdates` for retained mesh updates;
initial/structural packing is represented by `rebuilds` instead. See
`unchanged-update-profile.json` for the traced map branches and regression.
The controlled redundant-update regression skips 20 unchanged meshes while
updating two moving meshes, reducing uploads from 1,585,056 to 1,056 bytes/frame
with identical final pixels. The ten-player equipment scene is not reproduced
locally; its resulting FPS remains unmeasured.

Large branching containers and dense standalone geometry also own independent
Pixi render groups. Animated child replacement then rebuilds that branch's
instruction set and vertex buffer instead of the entire scene's. Groups are
promoted once and retained until the object is retired; unary wrappers are not
grouped unless they contain dense geometry of their own. These groups are not
extra texture passes. Branches with at least 6,000 vertices not already owned
by child groups also qualify for promotion, protecting detailed static siblings
from unrelated animation rebuilds. This threshold is not a hard buffer-size cap.
The Battleon fixture moved roughly 2–3 MB/frame through vertex uploads at
6,000 vertices, versus 4–11 MB/frame at the previous 12,000 threshold across
repeated short samples. Draw count rose slightly; software-GPU render time
varied between runs, so this is an upload reduction rather than a proven FPS
gain. Append `&groupVertexLimit=12000` to compare the old threshold. To compare the previous shape-count rule, stop and
re-enable with `pixiLiveControls.enable({groupVertexLimit:0})`.
The earlier dense-sibling regression at 12,000 vertices reduces uploads from 4,105,224 to 127,980 bytes
per frame (98 to 139 groups, 1,447 to 1,484 draws). Mean RGB difference is below
0.00003/255; maximum channel difference is 6/255. This is a controlled animated
sibling test over the offline Battleon fixture, not a gameplay FPS claim.
See `vertex-group-profile.json` for scope and measurements.
Small objects that change their vertex/index counts or shape count are now
promoted adaptively when their nearest batch contains at least 12,000 other
vertices. This protects static neighbors from morphs and animated stroke
geometry even when each individual object is below the normal size threshold.
Promotion persists for the object's lifetime; it adds an instruction group,
not a texture pass. The first change can rebuild the parent once. Re-enable
with `pixiLiveControls.enable({isolateTopology:false})` to compare.
See `topology-isolation-profile.json` for the controlled geometry-change test
and a short animated Battleon sample. In the controlled test, uploads fall
from 1,622,160 to 2,168 bytes/frame with identical pixels and one additional
group/draw. The static parent has zero subsequent rebuilds. In consecutive
animated samples, median uploads fall from 41.4 to 30.1 MB/frame and batch
update time from 27.45 to 16.95 ms (six additional groups/draws). These short
software-GPU samples use different animation frames and are not a gameplay
FPS claim. This targets CPU batch work and upload traffic; GPU draw/filter
cost remains.

Scenery texture caches remain separate. `batchGroups`
counts visible groups; append `&renderGroups=0` to compare without this partition.
The child-replacement regression reduces uploads from 413,370,536 to 157,140
bytes/frame and local batch-update time from 274.9 to 0.5 ms. It uses 98 groups,
with 1,447 draws instead of 1,338. Mean RGB difference is below 0.001/255.
See `render-group-profile.json` for scope and measurement limits; these are
submission timings on a software GPU, not a measured gameplay frame rate.

The browser regression compares the same uncached Battleon frame both ways:
7,568 WebGL draw calls become 1,337. Mean RGB error is below 0.001 on a 0–255
scale. This validates batching and image equivalence, not live gameplay FPS.
With scenery caching enabled, the separate 1100×630 SwiftShader profile reduced
draw calls from 5,151 to 1,355. Median GPU-completed time improved from 799.4 ms
to 770.5 ms; AwayFL took 527.9 ms in that fixture. Thus batching reduces driver
submissions but does not yet make this prototype faster than AwayFL. Submission
times include driver waits and must not be read as pure JavaScript CPU time.
Raw samples and measurement limits are in `vector-batching-profile.json`.
The adapter uses the pinned Pixi 8.21 mesh/batcher APIs and is WebGL-only.

Backdrop blending now resolves only the MSAA rectangle being copied, skips the
redundant pre-copy resolve, and defers backbuffer resolves until presentation.
Offscreen filter outputs still resolve before another filter samples them; the
final canvas still receives a full resolve. Antialiasing and resolution are
unchanged. This renderer-local adapter targets Pixi 8.21 WebGL internals and
restores its hooks on stop. Append `&boundedBlends=0` for the previous behavior.
`blendResolvePixels` and `blendResolveSavedPixels` are cumulative texel counts.

In the 2044×1171 offline Battleon fixture, this reduces MSAA resolve traffic from
1,134,645,064 to 2,862,835 texels per frame (480 to 148 blits). With scenery
caching disabled, median completed-frame time on SwiftShader fell from 2590.4 ms
to 920.3 ms; AwayFL measured 831.6 ms. These software-GPU results do not predict
hardware gameplay FPS. Raw samples and methodology are in
`blend-resolve-profile.json`. The browser regression compares pixels with the
optimization disabled/enabled, including nested filters and clipped backdrop reads.

Animated filter parameters now update existing Pixi filter instances instead of
removing and reattaching the effect chain. Blur strengths, shadow offsets,
colors, matrices, padding and resolution are mutable; shader-compiled glow
radius/quality, outline quality and kernel changes still replace the filter.
Retained effect output is invalidated and its bounds/resolution refreshed when
parameters change. Filter layout, blend mode and text-antialias changes still
rebuild the chain. To compare the previous behavior, stop and re-enable with
`pixiLiveControls.enable({reuseFilters:false})`.

The browser regression checks updated filters against freshly constructed ones,
including asymmetric shadows, zero blur, mixed chains, resolution changes and
cached text outlines. It also changes a native Flash blur three times inside a
large branch: three parameter changes now cause zero batch rebuilds and zero
buffer uploads, versus three rebuilds and 37,800 bytes/frame with replacements.
All 20 fresh-versus-updated filter comparisons have zero pixel difference.
Measurements and limitations are in `filter-reuse-profile.json`.
This optimization does not prevent rebuilds caused by changing geometry sizes.

To measure the next 12 actual draws on the current machine:

```js
pixiLive.profile().then(r => console.log(JSON.stringify(r)))
```

For a crowded scene, include the submitted Pixi filter workload by effect type:

```js
pixiLive.profile(12).then(({median, effects, frameTiming}) =>
  console.log(JSON.stringify({median, effects: effects.slice(0, 12), frameTiming: frameTiming.median})))
```

`effects` counts shader passes and draw calls over the sample. `targetPixels`
is the summed viewport area, while `quadPixels` bounds it by the output quad
and is the better estimate of shaded pixels. `submitMs` is CPU submission time.
These are workload clues, not per-effect GPU timings; `median.gpuMs` remains
the whole-frame GPU timer.

`cpu.median` separates picker traversal (`inputTraverseMs`), candidate
collection (`inputCollectMs`) and precise collision (`inputCollisionMs`) from
other picking work (`inputPickMs`). It also separates `timelineAdvanceMs` and
`timelineBroadcastMs` from other AVM2 timeline work. These fields are
exclusive: parent `inputMs` and `timelineMs` exclude nested measurements.
All hooks are active only during `profile()`.

To count the nodes visited by native mouse picking in a busy room, run a
separate short sample:

```js
pixiLive.profile(3, {pickTree:true}).then(({pickTree}) =>
  console.log(JSON.stringify(pickTree)))
```

`pickTree` counts accepted/rejected nodes, leaves, containers, pick-object
nodes, and visits by asset type across the sample. It instruments every picker
node, so its CPU timings include diagnostic overhead; use an ordinary
`profile(12)` sample for frame-time comparisons. Normal play is unchanged.

The opt-in `pixiPickBounds=1` mode uses retained Pixi bounds to avoid traversing
some distant Flash picker branches. AwayFL still resolves precise collisions
inside candidate branches; press/release and drag checks use native picking.
This is an accuracy experiment: hover on hit areas outside visible artwork can
be missed, so the default remains native picking.
Compare the same room with and without the flag using:

```js
pixiLive.profile(12).then(r => console.log(JSON.stringify({
  traverseMs:r.cpu.median.inputTraverseMs,
  fps:r.frameTiming.observedFPS,
  pickBounds:r.pickBounds
})))
```

`pickBounds` reports checks, skipped branches and time spent reading Pixi bounds
inside the sampled native ticks. If that time exceeds the traversal savings, leave the
flag off. `npm run check:pixi-pick-bounds` covers the broad-phase fallback;
`PIXI_BACKEND=direct-objects PIXI_PICK_BOUNDS=1 npm run check:display-list`
covers browser input.


In `direct-objects`, stationary hover skips native picking while Pixi reuses the
previously drawn frame. A new Pixi draw triggers a fresh pick on the following
tick. Add `retainedHover=0` to compare native per-tick picking. Optional hover
sampling defaults to 12 Hz while the mouse is stationary (`idleHoverHz=0`
restores a pick on every tick): in an animated room the retained-scene check
never holds, and a full hover pick per frame cost about 7 percent of a busy
frame. Objects animating under a still cursor are re-tested at that cadence.
Another cadence is available with `idleHoverHz=N` on either Pixi backend's play URL, or
`pixiLiveControls.enable({idleHoverHz:12})` after stopping the current backend.
That cadence can delay hover changes on animated objects moving under the pointer.
The retained-frame shortcut can also miss an invisible hit-area change until the
scene draws again; disable it if that matters for a particular UI.
Movement, queued button/wheel/enter/leave events, pressed buttons, dragging, touch,
coordinate changes and viewport resize bypass the limit. It does not cache hit
results, skip ActionScript frames, or enable AwayFL rendering. The original input
method is restored on backend stop. The profile's `hover` summary reports the
configured rate and check/skip counts inside sampled native ticks only; ticks
after the last sample while GPU queries complete are excluded:

```js
pixiLive.profile(12).then(({median, cpu, hover, frameTiming}) =>
  console.log(JSON.stringify({median, cpu, hover, frameTiming})))
```

`catchUp=1` enables bounded timeline catch-up in `direct-objects`. When a browser
callback arrives late, it can advance up to three SWF frames and draw only the
last state through Pixi. Recent expensive work limits it to one frame to avoid a
catch-up spiral. It is opt-in because skipped intermediate draws can change the
appearance of frame-by-frame effects. Compare with the same URL without the flag:

`https://localhost:4433/game/gamefiles/pixi-benchmark/play.html?backend=direct-objects&nativeGraphics=1&renderScale=0&fps=1&catchUp=1`

`pixiLive.stats.catchUpExtraSteps`, `catchUpSkippedRenders`, and
`catchUpRecentWorkMs` show when it actually catches up. The original timer
callback is restored when Pixi stops. `npm run check:catch-up` covers its
timeline and render behavior.

`shapeSprites=1` is an opt-in test for detailed, solid-color authored paths when
`nativeGraphics=1` is active. It renders an eligible path once to a shared Pixi
texture and uses tinted Sprites for its instances. Short paths, strokes,
gradients, bitmaps, large shapes, and mutable geometry keep their existing
Graphics or Mesh path. Raster textures use 2× resolution and a 32 MB pixel
budget; zooming beyond that can look softer than vectors. Compare the same
scene with and without the flag:

`https://localhost:4433/game/gamefiles/pixi-benchmark/play.html?backend=direct-objects&nativeGraphics=1&shapeSprites=1&renderScale=0&fps=1`

`pixiLive.stats.shapeSpriteBuilds`, `shapeSpriteUses`, and `shapeSpritePixels`
show how many paths were baked, how many instances reused them, and the current
texture budget. `npm run check:shape-sprites` checks sharing, invalidation, color,
and a game scene fixture. This mode is experimental until its FPS and sharpness
are compared against the same scene without it.

`pixiEvents=1` enables the experimental Pixi v8 `EventBoundary` target picker
for hover and pointer movement in `direct-objects`. The chosen branch is passed
to AwayFL's Flash collision and event dispatcher. If that branch misses, the picker
retries the full AwayFL tree. Press, release, wheel and dragging stay native
while Flash button hit areas are mapped. Pixi target picking and
`pixiPickBounds=1` are mutually exclusive; use one at a time. This mode may
still select the wrong overlapping Flash target and is opt-in while button,
mask, and hit-area coverage is verified. `pixiLive.stats` exposes
`pixiEventPicks`, `pixiEventHits`, and `pixiEventFallbacks` for comparison.
Shape art and other mouse-disabled objects stay hittable in Pixi: Flash routes
such hits to the nearest mouse-enabled ancestor, and the scoped native pick
applies `mouseEnabled` and `mouseChildren`. Marking them passive made the
boundary miss almost everywhere, so each hover tick fell back to the full
native tree. Press, release and wheel use the scoped pick as well
(`pixiEventsScopedPress=0` restores a full native pick per click, which costs
about a frame each in combat). Invisible hit states such as a map's walkable-
area button have no Pixi art, so the display list tracks every object with a
hit state (`hitStateNodes`) and the scoped traversal always admits their
branches; the native pick then prefers them exactly as the full tree would.
Input fields carry an explicit Pixi hit rectangle covering their box, so a
press on empty space inside one resolves to the field. Verified in a live
room: a floor click walks the avatar through the scoped press. A button's timeline hit state is admitted to the scoped
traversal exactly when its owner is. The scoped native pick tries the candidate's own branch first and
widens to its parent and grandparent only on a miss: over a room background the
parent is the whole room, and picking it cost as much as the full tree.
`pixiEventsCull=1` (off by default) prunes a record's branch when the hit
location lies outside the node's AwayFL box in root space
(`pixiLive.stats.pixiEventCulls` counts prunes). Pixi's own traversal has no
bounds culling, so a point over the floor visits every avatar leaf before
reaching the map, but the AwayFL box is only cached while a branch is still:
for animated avatars each lookup re-traverses the subtree and recomputes every
entity's box, which cost twice the traversal it replaced in a live room. It
stays available for comparison against a cheaper bounds source.
Three details keep the Pixi candidate honest. Mesh hits use an exact,
topology-aware triangle test (`meshContainsPoint`): Pixi's own
`Mesh.containsPoint` walks an indexed triangle list one index at a time, so a
mesh with a hole (the letterbox frame the game keeps on top of its stage)
counted as solid and swallowed every click. Mask containers are pruned, and a
mask that is a plain record container answers for the art inside it, so
content clipped by a Flash mask (inventory rows) is neither hit through the
mask nor dropped entirely. The scoped traversal admits the masks of every
admitted ancestor together with their subtrees: the native picker accepts a
clipped entity only after the mask's own picker hits, and that mask is usually
a sibling of the content, outside the candidate's ancestor path. Verified in a
live room: a click on an inventory row selects it through the scoped press,
with the scoped and full picks resolving to the same row.

SWF hairlines decode with thickness 0 (width 0 twips) and morph shapes carry
them on every rebuild, usually with alpha 0; the stroke snapshot accepts a zero
thickness for hairlines, so they defer like every other hairline instead of
being tessellated and filling the morph cache.
`__PIXI_FLASH_PATHS__.lazyStats.morphStrokeFallbacks` and `morphFillFallbacks`
count why a morph path was tessellated instead of deferred.

Retained mesh geometry keeps a hold on the tracker records of the buffers it
was built from until the geometry is evicted. The tracker otherwise forgets a
buffer two frames after it was last seen, and a fresh record means a fresh
revision, so a hidden animation frame that came back a cycle later never
matched its retained geometry and was rebuilt: about 10 rebuilds and 16
thousand converted vertices per frame in a room, now about one small rebuild
per frame. `retainGeometry` defaults to 4096 entries (`stats.geometryRetained`
shows how many unused entries are held); `stats.traceGeometry = true` records
each build's reason into `stats.geometryTrace`.

`npm run build:native:profile` writes the same `native-runtime.js` without
minification, so a DevTools trace names the parse, symbol construction, JIT
and tessellation functions instead of one-letter aliases. Use it to record a
trace across an asset arrival (a room change, a new player's gear), then run
`npm run build:native` again before measuring frame times: the profiling
bundle is larger and loads more slowly.

`morphCache=1` keeps built morph geometry per symbol and ratio and shares it
between every instance of that symbol, so a looping shape tween tessellates
each ratio once instead of on every frame. The retained set is bounded
globally rather than per instance: `morphCacheLimit=N` (default 4096 entries)
and `morphCacheMB=N` (default 96) evict the least recently used ratios that no
instance is showing. `morphCacheSteps=N` rounds ratios to 1/N before lookup,
trading exact tween positions for fewer distinct builds; it is off by default.
`window.__PIXI_MORPH_CACHE__` reports `hits`, `builds`, `shared`, `live`,
`bytes`, `evictions` and `top()` per symbol. Combine it with
`morphNativePaths=1`: cached Graphics keep their authored path snapshots, so
Pixi reuses the same `GraphicsContext` for a repeated ratio.

Unused native path contexts and mesh geometry are retained across sweeps in
least-recently-used order (`retainPaths=N`, default 4096 contexts, and
`retainGeometry=N`, default 2048 geometries; `0` restores immediate release).
Without this, a morph returning to a cached ratio still rebuilt its Pixi
context every frame. Bitmap-filled and rasterized contexts are not retained;
they follow their texture's lifetime. `pixiLive.stats.nativePathRetained`,
`nativePathRevivals` and `geometryRetained` show the effect.
Flash hairlines (zero-width strokes) now take the authored path as Pixi
`pixelLine` strokes, one device pixel at any scale, exactly their Flash width.
Before this they stayed Flash line meshes whose extrusion was recomputed on
every transform change and repacked through the vector batcher. Other
non-scaling strokes keep the screen-space mesh route.
`effectTextures=1` (direct-objects) caches each stable, unmasked, normal-blend
filter group as a Pixi render-group texture after two unchanged frames. A
retained effect otherwise still renders its source subtree into a filter input
every frame before blitting the cached result; the cached group is one batched
quad until its revision or scale changes. Budget 16 Mi texels;
`pixiLive.stats.effectTextures`, `effectTexturePixels`, `effectTextureBuilds`
and `effectTextureRejected` report it. It is opt-in because a subpixel move of
a cached group resamples the texture instead of re-rendering the effect.

A rotation or scale of an ancestor no longer re-prepares descendants whose
Pixi content does not depend on the world transform. Filters, native text,
screen-space strokes, scenery raster candidates and 3D content mark their
subtree transform-sensitive and keep the full re-preparation;
`linearReuses` counts the retained notifications, and the translation
regression compares pixels against a forced invalidation.

Groups with up to six draws (own shapes or single-draw children) that do not
overlap each other now use GPU add/multiply/screen blending directly (`directMultiBlendGroups`;
`directMultiBlend=0` restores isolation). `antialias=0` disables MSAA on the
Pixi canvas, which also removes the per-pass resolve before every backdrop
copy; `bezierSmoothness=N` (Pixi default 0.5) lowers curve subdivision, which
Pixi computes in authored units rather than screen pixels.
Every multi-contour fill now uses the containment tree with explicit holes;
Pixi's signed compound path missed a hole whose contour winding matched the
outer one, so a chest icon's frame drew solid over its planks (`chest.swf`).
A masked object is never promoted to its own Pixi render group: a stencil mask
rendered from another group's transform clipped inventory lists at the wrong
place. A node in mask mode stays visible to Pixi even when Flash hides it:
AwayFL's TextField clips overflowing glyphs with a mask child it keeps hidden,
and Pixi fills a stencil only from a visible mask container, so the
inventory's gold amount was clipped away entirely. `hairlines=0` (runtime) keeps hairlines on the mesh route and
`reuseLinear=0` restores full re-preparation on rotate/scale, both for
comparison. The proxy loader accepts any `entry=<name>` SWF under gamefiles,
so a single asset can be rendered alone for inspection.
`pixiLive.stats.unsupported` lists `native-fallback:<reason>` counts for
authored paths that still use the mesh route (`contours`, `paint-offset`,
`no-snapshot`, ...); a deferred morph shape pays a full tessellation there.
`npm run check:morph-cache` covers sharing, budgets, replacement and
quantization; `npm run check:path-retention` covers both retention caches.

Use `PIXI_BACKEND=direct-objects PIXI_IDLE_HOVER_HZ=12 npm run check:display-list`
to exercise the opt-in path, including native mouse/keyboard input and periodic
stationary hover checks. `npm run check:idle-hover` also checks immediate queued
input, dragging/touch, resize, profiler composition and restoration.

The result's `groups` list ranks branches by actual uploaded bytes over the
whole sample. Each entry includes the native object `path`, `rebuilds`, exclusive
`updateMs` (child group work excluded), `uploadBytes`, `draws`, and `triangles`.
`vertexBytes` is the largest used vector vertex buffer; `changedBytes` totals
bounding spans on partial updates, including untouched gaps. `uploadBytes`
measures the actual traffic after splitting those spans. These are sample
totals, not per-frame medians.
Group uploads/draws cover batch execution; standalone filter/uniform traffic
can remain unattributed and is still included in the overall frame counters.
All instrumentation is removed when the bounded sample completes or is stopped.

Profiles also include `p95` (nearest-rank 95th percentile) and `frameTiming`:

- `frameWorkMs`: wall time inside the native `showNextFrame` call, including rendering.
- `runtimeMs`: that work excluding the adapter; includes input, ActionScript,
  timelines, sound and direct-binding changes made during those operations.
- `adapterMs`: the whole adapter call, including sync, Pixi rendering and cleanup.
- `frameIntervalMs`: start-to-start native frame spacing; its first sample is null.
- `observedFPS`: native tick cadence across the sampled interval. The tick
  summary includes unchanged frames that reuse the canvas; draw metrics still
  describe only actual Pixi draws. Manual renders have null native frame times.

The `cpu` summary splits native frame work into exclusive sections. Its
`mean`, `median` and `p95` use native ticks, including ticks reusing the canvas; manual
adapter renders use drawn frames instead (`cpu.basis`). Each raw draw has `cpu`
values for its containing tick:

- `inputMs`: mouse picking/event dispatch, excluding binding callbacks.
- `timelineMs`: the AVM frame handler (ActionScript/timelines), excluding binding callbacks.
- `runtimeBindingsMs`: direct-object adapter callbacks triggered during native work.
- `runtimeOtherMs`: remaining native work, including sound and uninstrumented hooks.
- `syncSetupMs`, `syncVisitMs`, `syncMasksMs`, `syncRetireMs`, `syncSceneryMs`:
  adapter setup, tree synchronization, mask resolution, detached-object retirement,
  and scenery-cache preparation, excluding binding callbacks.
- `syncNativeMs`: lazy entity preparation and native graphics traversal during
  synchronization, excluding the Pixi conversion callbacks it invokes.
- `syncShapeMs`: shape conversion/update callbacks, including geometry, material,
  texture and shared native Pixi path preparation. These two sections were
  previously included in `syncVisitMs`; compare their sum with older reports.
- `syncBindingsMs`: binding callbacks during adapter work.
- `pixiRenderMs`: Pixi submission, including batch updates and driver waits.
- `adapterCleanupMs`, `adapterOtherMs`: resource cleanup/status updates and
  remaining adapter work.

Use `cpu.mean.inputMs` to measure the average cost of intermittent hover checks;
the median can still show a full check if more than half the ticks check hover.
Nested callbacks are charged once, to the innermost section. Per-frame sections
partition measured work; adding separate medians does not reproduce a median
frame time. Existing `runtimeMs`, `syncMs`, and `renderMs` are inclusive and
must not be added to these sections. Native hooks that are unavailable cannot
be separately attributed and remain in the corresponding `OtherMs` section.
The extra clocks run only during `profile()`, so samples include instrumentation
overhead. No clocks or scope allocations run for these sections otherwise.
The offline timing-partition check is recorded in `cpu-breakdown-profile.json`.
Profiles also include `configuration` (backend and native graphics/retention
options) and `scenery.start`/`scenery.end` counters. These distinguish disabled
caching from candidates warming up or being rejected without another traversal.
For a compact CPU report:

```js
pixiLive.profile(12).then(({configuration, scenery, median, cpu, frameTiming}) =>
  console.log(JSON.stringify({configuration, scenery, median, cpu, frameTiming})))
```

These wall times include any synchronous driver waits. GPU work overlaps CPU
work and must not be added to it. Work between native ticks appears in frame
spacing, not in `runtimeMs`. The temporary player hooks are restored on sample
completion, cancellation and renderer stop, without replacing later external
changes. Sampling stops after the requested draws (or the existing 30-second
timeout), with at most 2,048 native tick records. Use 60 draws to inspect dips:

```js
pixiLive.profile(60).then(({median, p95, frameTiming}) =>
  console.log(JSON.stringify({median, p95, frameTiming})))
```

This opt-in diagnostic reports per-frame and median synchronization time, render
call time, Pixi batch-update time, draw/triangle counts, uploaded buffer bytes,
MSAA resolve texels and asynchronous GPU timer results when supported. CPU
timings can include driver waits; GPU timers are discarded on a disjoint event.
No pixel readbacks or forced GPU waits are used. Sampling does not force draws;
an idle/paused scene may return a partial report after 30 seconds. Hooks and query
objects are removed on completion, timeout, or switching away from Pixi.

The Flash runtime still advances timelines and runs scripts, bounds and input.
Initial and changed content still needs preparation, and animated scenes still
need drawing. This removes the unconditional preparation scan; it does not
establish a particular in-game FPS.

`pixiLive.stats.directTransformUpdates` and `directHierarchyUpdates` count actual
changes. `polledTransforms` stays zero in this backend. `preparedNodes` and
`skippedSubtrees` describe the latest frame; `reusedPreparations` counts frames
that skip preparation entirely. `nodes` and `meshes` still describe the whole
visible scene, including skipped branches. For diagnostics,
`pixiLive.getDisplayObject(flashObject)` returns the owned Pixi container.

The mutation bridge distinguishes content invalidation from a translation-only
change. Dirty descendants no longer trigger preparation of an unchanged
ancestor's own meshes. Those meshes and their asset subscriptions stay attached;
changed graphics, text, shared assets, inherited color/scale and reattached
objects still request preparation. This reduces preparation inside dirty
branches; it does not yet remove the ancestor walk or mask/effect bookkeeping.

`preparedContents` and `retainedContents` count actual content preparations and
reused content within visited nodes in the latest frame. They are also included
in `profile()` medians. Entirely skipped subtrees are counted separately by
`skippedSubtrees`. For comparison, enable with `{retainContent:false}` to restore
preparation of each visited object's content. The offline mutation comparison
is recorded in `retained-content-profile.json`: translation prepares no content,
a child geometry/color edit prepares one object, and all 14 cases match forced
full preparation pixel-for-pixel. These are correctness/work-count checks, not
hardware FPS measurements.

Mask-only notifications now update the owning Pixi mask wrappers without
invalidating descendant geometry or paint. Actual mask geometry edits, mask-mode
changes, mixed invalidation flags, child edits and other pending work retain
normal invalidation. `localMaskUpdates` counts these notifications cumulatively;
`{retainMaskedContent:false}` restores the conservative behavior for comparison.
The six-tick offline Battleon audit is in `mask-invalidation-profile.json`.
The browser suite compares live mask changes against forced full preparation,
including script/timeline masks, intersections, geometry/position edits and
scroll rectangles. Native Flash picking/event invalidation is unchanged.

Color-only notifications compare an owned snapshot of the eight local color
channels before scheduling preparation. Exact repeats preserve pending work and
skip new preparation; real channel changes, mixed flags and unknown layouts keep
the conservative behavior. Flash's original invalidation still executes.
`unchangedColorUpdates` is cumulative. `{skipUnchangedColors:false}` disables
this optimization for comparison. The offline audit is recorded in
`color-invalidation-profile.json`; it found 17 exact repeats among 89 color
notifications in six ticks. This is a limited optimization, not a solution to
crowded-room timeline or mouse-picking costs.

`npm run check:direct-bindings` verifies copied snapshots, in-place edits, all
channels, pending work, combined invalidations and hook cleanup. The browser
mutation checks also compare repeated/changed colors and pending geometry edits
against full preparation at identical scene state.

Run the existing browser regression suite against this backend with:

```sh
PIXI_BACKEND=direct-objects npm run check:display-list
```

It additionally checks mutations before rendering, identity across reparenting,
stable transforms and zero prepared nodes across idle renders, isolated branch
updates, shared bitmap edits, and hook/ownership cleanup on stop. The offline
Battleon fixture also verifies a retained scene with more than 9,000 meshes;
this paused-fixture check is not a live gameplay performance measurement.

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
are disabled. Capture failures pause Pixi and unbind any interrupted AwayFL
vertex array. WebGL hooks are restored on an explicit switch back to AwayFL.
Stopping Pixi does not destroy AwayFL's graphics context.

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

Hairline and non-scaling strokes are extruded in render pixels, so enlarged
inventory previews keep thin lines. Their geometry cache includes the linear
transform; translated instances still share geometry. Normal strokes continue
to scale with the object. Horizontal/vertical-only stroke modes remain reported
as compatibility gaps.

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
Text-bearing filter groups preserve multisampling on their source targets. Narrow
text borders use a smaller outline radius than the blur-width approximation for
other graphics, avoiding heavy borders and aliased glyph interiors.
Unchanged parameters reuse filters. A changed glow radius recreates the filter,
because Pixi compiles its WebGL sampling radius into the shader.

Geometry is already shared and retained across frames (`geometryEntries`,
`geometryUsers`, and `geometryBuilds` in `pixiLive.stats`). The direct backend does
not yet flatten display groups with `cacheAsTexture`. It synchronizes the display
list each tick, but reuses the completed canvas when drawing inputs are unchanged.
Text/geometry, bitmap pixels, transforms, colors, masks, child order, filters and
resizing invalidate that frame. This saves idle-screen rendering; an animated
scene still draws the full scene. Normal filter groups additionally retain their
completed effect texture: an unrelated hover or animation does not rerun a static
title's glow/shadow chain. Subtree revisions invalidate these textures for source
edits, inherited colors, transforms (including fractional ancestor movement),
child order, filters and viewport changes. Advanced blends and subtrees containing
external masks stay uncached. Continuously changing effect groups also bypass
retention until stable, avoiding an extra texture copy on animated frames.
Retained effect textures are bounded to 64 MiB total
and 32 MiB per group; Pixi's temporary texture pool is separate. Source meshes still
draw into filter inputs, so this is not full subtree texture caching.
Unfiltered, unmasked groups containing a single draw use GPU add/multiply/screen
blending directly. Groups with multiple draws remain isolated, preserving the
composite of overlapping children. `directBlendGroups` and `isolatedBlendGroups`
report these paths per frame. Unchanged mesh paint and colors retain their shader
uniforms (`uniformUpdates` counts updates); retained geometry avoids repeating the
serialized layout lookup while still checking source buffer revisions.
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
`pixiMs` is zero for reused frames. `effectCacheHits` counts reused effect outputs,
`effectCacheBuilds` counts retained outputs built, `effectPasses` counts stages run by cache-eligible groups
(a blur can have multiple internal GPU passes), and `effectCachePixels` counts
currently retained RGBA pixels. For a comparison without effect retention, stop
Pixi and call `pixiLiveControls.enable({cacheEffects: false})`; the default is true.
`geometryEntries` counts retained unique geometry objects, `geometryUsers` counts
the retained meshes using them, and cumulative `geometryShares` counts acquisitions
that reused geometry already held by another mesh. Retention includes briefly
retired and hidden records, so users need not equal the current visible mesh count.
Timings are CPU synchronization/submission times, not GPU completion times. The
header shows the measured frame rate. Omit `backend=display-list` to use the
existing bridge, or click **Use AwayFL** to switch to the native renderer.

Validation:

```sh
npm run check:vector-inputs
npm run check:render-profile
npm run check:upload-ranges
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

`pixiLive.stats.active` becomes false on an explicit stop. A render failure now
keeps Pixi selected with `failed: true`, pauses the game and records `lastError`.
Frame timings then remain those of the last successful frame. The fallback
measurements below describe older versions of the bridge.

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
# Authored paths in native Pixi Graphics (opt-in)

Use `play.html?backend=direct-objects&nativeGraphics=1&renderScale=0&fps=1`
to try the first native graphics stage. Build with `npm run build:native` and
`npm run build` in this directory. The separate `native-runtime.js` captures
decoded path commands before the first SWF loads; the regular AwayFL runtime is
unchanged. `loader-native.html` is generated from the proxy's existing loader.

Solid, linear-gradient and repeating bitmap fills with supported contours, plus
normal-scaling solid strokes with move, line, quadratic and cubic commands, now
become Pixi `Graphics` using a shared, immutable `GraphicsContext`. They use
the standard Pixi graphics pipeline, not the Flash vector mesh shader. Each instance
retains its transform and color; moving/recoloring it does not clear or recreate
the context. Contexts are released after their final graphics user is retired.
For SWF shapes, the experimental runtime snapshots path commands when a shape
definition is serialized, before AwayFL tessellates it. ActionScript-drawn
paths still use the graphics-factory capture. Both routes share the same Pixi
context per authored path, and edited paths discard their saved definition.
While Pixi is active, authored solid, supported gradient, and repeating
bitmap fills (including compound contours) defer AwayFL's triangle generation. The temporary
bounding rectangle preserves conservative bounds until the real triangles are
needed. Unsupported fills, strokes, and edited paths still use AwayFL's
geometry path.
The snapshot now also contains immutable, parsed segments and conservative
path bounds that include curve extrema (stroke thickness is separate). Pixi consumes those segments directly when constructing its shared
`GraphicsContext`, without re-parsing command offsets for each context. These
data are prepared before any AwayFL triangles for SWF definitions. A native
element hit test, geometry edit, scale/scale9 operation, Pixi mesh fallback,
or `BitmapData.draw`
materializes deferred triangles when needed. Switching back to the AwayFL
renderer materializes all remaining deferred shapes. The live counters are in
`pixiLive.stats.deferredGeometry` (`skipped`, `materialized`, `live`, plus
the corresponding `*Strokes` counters).
Append `&pixiBitmapDraw=1` to try the Pixi `BitmapData.draw` bridge. It renders
a previously prepared display subtree, including internal timeline masks, into
a Pixi render texture. It reads the pixels into an unused transparent Flash
bitmap; unsupported draws stay on AwayFL's offscreen path. The Battleon map
fixture exercises a 2,000-object subtree. This is a correctness experiment: the synchronous
GPU readback and separate AwayFL texture upload can cost more than the original
draw. `pixiLive.stats.pixiBitmapDraws` counts successful draws. The browser
pixel comparison for nested graphics and the map is `npm run check:bitmap-draw`.
With native graphics enabled, single-contour fills and strokes now use their
retained Pixi `GraphicsContext` for bounds and the fine hit test. Flash still
dispatches mouse events. Compound shapes, partial mesh ranges and elements
shared by different contexts keep AwayFL's bounds and hit test.
The hook is released when its last Pixi user retires and restored on switch
back to AwayFL. `npm run check:native-picking` covers the ownership rules;
`npm run check:native-paths` exercises fill and stroke hits in the browser.
Single `drawRect`, `drawCircle`, `drawEllipse` and circular-corner
`drawRoundRect` fills are also captured before AwayFL turns them into triangles.
Pixi draws them with native primitive commands, using the same shared-context
and paint rules. Elliptical corners, multiple primitives and simultaneous
strokes keep the mesh renderer.
Plain, single-format dynamic text in common browser fonts uses Pixi `Text`
inside the AwayFL `TextSprite` display object. Its existing transform, text
field layout, masks and parent filters still apply. Edited text creates a new
Pixi text texture; moving the field retains it. Wrapped fields use one Pixi
text object per AwayFL-calculated line, preserving Flash's break points and
line origins. Uniform-color lines use `Text`; mixed-color lines use `HTMLText`.
Input fields, mixed font styles and custom embedded fonts keep the glyph-mesh renderer. This is
enabled with `nativeGraphics=1`, and `nativeText=0` disables it for comparison.
Single-line fields with multiple color runs and otherwise matching font styles
use Pixi `HTMLText`, with HTML-escaped content and Flash color transforms applied
to each run. The login screen's “New Release” title exercises this path. Pixi
loads HTML text textures asynchronously; the adapter requests a new draw when
each texture becomes ready, including when the scene is otherwise unchanged.
Text texture resolution follows its effective screen scale (capped at 4) so
scaled interface labels do not stretch a one-pixel-per-unit raster.
`nativeTexts` counts active Pixi text objects in the current frame. AwayFL still
does text layout and glyph construction for bounds and compatibility.
`pixiLive.stats.nativeGraphics` counts instances currently represented this way;
`nativePathBuilds` and `nativePathShares` are cumulative.
Linear and centered radial gradients use Pixi `FillGradient` with the decoded
SWF color stops and UV transform. Copies share one compiled context.
`nativeGradients` counts live gradient instances. Browser fixtures compare both
types with the mesh backend. Focal radial gradients, reflect/repeat spread and
linear-RGB interpolation retain the mesh path.
Repeating bitmap fills use the decoded UV matrix and shared Pixi texture with
the authored path. CPU-backed bitmap edits refresh that texture without rebuilding
the path. `nativeBitmaps` counts live native bitmap-fill instances. Non-repeating
fills retain the mesh renderer because Pixi Graphics currently forces repeat
sampling for textured fills.
For two-contour fills, Pixi `GraphicsPath` handles both an inner hole and
separate filled islands. Three or more contours are classified into nested
regions: Pixi fills outer shapes and islands, and cuts their direct holes.
Intersecting contours without a clear containment relation retain AwayFL mesh
rendering. `nativeCompounds` counts live multi-contour fill instances.

Strokes use Pixi's native `stroke()` with centered width, cap, join and miter
settings. Open and closed contours and multiple disconnected stroke paths are
supported. They share contexts exactly like fills, including across translated,
rotated and scaled instances. Hairlines and non-scaling strokes retain the mesh
implementation; this does not re-enable the `pixelLine` experiment. Authored
normal-scaling solid strokes now defer AwayFL line-buffer generation while Pixi
is active. AwayFL still prepares their paths; it builds the line buffer if a
native geometry operation, compatibility mesh, offscreen draw, or renderer
switch needs it.

In native graphics mode, ordinary fallback meshes also use Pixi's default batcher,
so interleaved Graphics and compatible meshes can share draws. Only meshes needing
Flash curve, radial-fill or color-offset shader inputs use the Flash batcher.
The default batcher retains Pixi's shader/packing code; a renderer-local adapter
tracks changed vertex ranges for partial uploads and skips identical mesh updates.
Structural rebuilds still upload the full affected buffer. Stop and enable with
`pixiLiveControls.enable({nativeBatching:false})` to compare the previous routing.
`npm run check:native-batching` compares frozen Battleon pixels and draw counts,
then samples animated frames separately. Headless software-renderer timings are
not a prediction of hardware FPS.

Intersecting compound fills, focal/reflect/repeat gradients, non-repeating bitmap fills,
non-scaling strokes, morphs, rich and embedded text, nine-slice shapes, elliptical-corner rounded
rectangles and mixed primitive paths retain the existing mesh path.
This is a partial migration, not a removal of the Flash runtime: native geometry
still supports bounds, picking and compatibility. It does not yet bypass AwayFL
tessellation or eliminate the synchronization pass. SWF shape data is decoded,
not generated by the ActionScript JIT; SWF paths are captured at definition
serialization and dynamic paths at the graphics factory.

`npm run check:path-source` verifies snapshots, unsupported inputs, sharing,
buffer edits and pooled-shape invalidation. `npm run check:native-paths` checks
actual rendered fill pixels, curves, native primitives and plain text, shared contexts,
transform reuse, edits, clear, visibility and mixed-primitive fallback in a
disposable browser tab. The full
offline scene suite also accepts `PIXI_NATIVE_GRAPHICS=1 PIXI_BACKEND=direct-objects`.

Static authored paths are converted once per shared context. Timeline transforms
reuse the context, while geometry edits create a new one. Remaining migration
work includes intersecting compound fills, non-repeating bitmaps, focal and
non-pad gradients, elliptical and mixed primitives, rich/embedded text and dynamic/morph geometry. The runtime still creates native geometry for
bounds/picking; eliminating that dependency requires replacing those consumers
as well as the visible renderer.

Constant-UV solid fills in the mesh fallback track their sampled texel rather
than the revision of a whole shared palette. Writes to other colors no longer
invalidate them. Checks are coalesced before synchronization and still observe
actual sampled pixel edits, dimensions, premultiplication and GPU-side changes.
`check-texture-samples.mjs` covers dependencies/lifetime; the browser check of
the same name with `-browser` compares pixels against `sampledTextures:false`.
