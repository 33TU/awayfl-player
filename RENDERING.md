# AQWorlds rendering

The local `fix/aqw-rendering` player branch uses the sibling `../renderer`
checkout at AwayJS `v0.11.99` plus the `fix/scale9-opacity` fix. This matches the
installed renderer version. The renderer's interface exports are marked
`export type` so Rspack can compile its TypeScript sources without warnings.

`MeshView.fromAttributes` added each triangle to the mesh once per vertex.
Nine-slice shapes consequently drew three overlapping copies of every triangle.
An 85% black fill became approximately 99.7% opaque. Adding each polygon only
once restores the login panel's transparency and removes redundant geometry.
The AQW panel's subdivided vertex count falls from 7,884 to 2,628.

Run the regression check from `awayfl-player`:

```sh
node scripts/check-scale9.cjs
npm run build:prod
```

The test checks triangle coverage, area conservation through all four nine-slice
cuts, and UV interpolation. The actual loader login screen was also checked in
Chrome using the production bundle.

The player accepts an optional `engineSettings` object before stage creation.
It applies settings through AwayJS's ConfigManager; these settings are shared
by all player instances in the page. The Hono AQW preview opts into:

```js
engineSettings: {
  scene: { USE_UNSAFE_FILTERS: true, USE_UNSAFE_BLENDS: true },
}
```

Filters are otherwise disabled by the scene defaults. Enabling them restores
AQW's logo glow and shadow. Native blend modes are also enabled for this preview.

The remaining pale highlights on the login/register buttons use `overlay`.
That requires the stage's `USE_NON_NATIVE_BLEND` compositor, which currently
loses much of the rendered scene when enabled for this SWF. It remains disabled;
this change does not claim full Flash filter/blend parity. Fixing that compositor
is a separate renderer issue, rather than changing the SWF's colors or alpha.

## Battleon black rectangles after joining a room

AQW rasterizes background MovieClips with `BitmapData.draw`. Those clips use
negative local coordinates, which the draw matrix translates into the bitmap.
The renderer clipped their filter bounds against the screen origin before
applying that translation. Some blur textures acquired negative dimensions
(for example, 412 by -368), and the cached background contained black rectangles.

The renderer's `fix/bitmap-filter-bounds` branch preserves full filter bounds
when the root view targets an image. The destination texture clips the final
draw. Normal screen clipping is unchanged. Keeping the full filter image can
use more temporary texture memory than clipping it to a viewport.

```sh
node scripts/check-bitmap-filter-bounds.cjs
```

The check exercises the actual renderer bounds calculation with translated
geometry and confirms screen clipping remains intact. It fails on the previous
renderer. Browser validation loaded the cached Battleon SWF under a mock World
and drew its background into a transparent 960 by 500 BitmapData using the
map's transform. The black terrain was reproduced before the fix and disappears
afterward with blur/glow enabled. This does not substitute for a full authenticated
room-join test.

## Empty filter targets during room changes

The renderer's local `fix/empty-filter-bounds` branch handles empty cached
clips without throwing `Cannot have image with size 0 * 0`. Missing bounds now
reset the previous cache rectangle, and disjoint viewport intersections become
empty rectangles instead of negative texture dimensions. Traversal skips empty
caches before material rendering; cache rendering also checks bounds before
pushing a render target. No zero-sized image is allocated or resized, and normal
invalidation resumes rendering when content returns.

`node scripts/check-bitmap-filter-bounds.cjs` covers empty bounds, viewport-edge
and fully offscreen clips, stale-cache suppression, and empty-to-visible image
reuse. The previous renderer fails the expanded check with the reported error.
The production build and a Chrome smoke check also pass: a glow-filtered Sprite
on the AQW login screen was drawn, cleared, and redrawn five times, then visibly
rendered again. This checks recovery, but does not reproduce the user's exact
authenticated room transition.

## Overlapping dynamic menu labels

The scene's `fix/text-layout-glyphs` branch fixes duplicate glyph geometry after
a TextField layout change. Glyph generation emits every text run, but previously
only discarded the old shapes when character data changed. Resizing centered
text left both its old and new positions visible, as in the game menu's small
"New Release!" and "Upgrade Now!" labels. Each glyph rebuild now starts with
empty shapes, including when only the field width changes.

```sh
node scripts/check-text-layout.cjs
node scripts/check-password-masking.cjs
```

The regression check uses the source TextField and actual triangle glyphs. It
checks centered positions and stable geometry counts across repeated resizes,
then shrinking and clearing the text. The previous implementation fails by
doubling the glyph count on the first resize.

Browser validation uses the actual `GameMenu.createLabel` from the cached menu
SWF, with its embedded Arial font and drop shadow. Repeated width changes now
render a single label without accumulating geometry. The production build and
password masking regression also pass.

The remaining frame-script errors are separate. Five `Default_fla` scripts in
`hair/M/Default.swf` call `stage.getChildAt(0)` without a null check, matching the
five repeated failures in the room-join log. The exact avatar lifecycle that
leaves these clips detached has not yet been verified in an authenticated join.
Do not suppress all detached MovieClip scripts: Flash also runs orphan clips.

## Missing player names

The scene contains two `Mini 7_10pt_st` font definitions: symbol 617 contains
218 characters, while symbol 3296 contains only `9`. The player name field
references the latter and starts with the authoring placeholder `9999`.
AwayFL kept that exact font table after ActionScript replaced the placeholder
with a username, so letters had no glyphs or advance widths.

The SWF loader's `fix/dynamic-text-font-lookup` branch resolves embedded
DefineEditText fonts by family and style within the movie's namespace. This
uses the first registered family/style, consistent with Ruffle's dynamic text
lookup (`html/text_format.rs`, `html/layout.rs`, and `library.rs::FontMap`).
Static DefineText records retain their original font IDs because their glyph
indices refer to that specific definition. Non-embedded text is unchanged.

```sh
node scripts/check-dynamic-text-font.cjs
```

The test covers duplicate subsets, runtime text replacement, movie isolation,
styles, cloning, and preservation of static glyph IDs. It fails before the fix.
Browser validation constructs the actual `AvatarMC` from the game SWF and sets
its `pname.ti` field to a username. Before the fix it produces no glyph geometry
and zero text width; afterward it renders with the 218-character pixel font.
This isolates the label without requiring an authenticated room join.

## Names disappearing after room changes

A second issue affected name positioning, independently of font selection.
AQW can call `AvatarMC.scale` before attaching an avatar to the scene. It
converts the head point using `mcChar.localToGlobal`, then the avatar's
`globalToLocal`. AwayFL created view nodes lazily from the queried child, so
the first conversion could omit the avatar's transform. The second conversion
created the missing parent node and subtracted the avatar's position anyway.
For an avatar at y=350, the name ended up at -488 instead of -138 and remained
offscreen after attachment. Whether rendering or another query had already
initialized the nodes made the failure appear intermittent.

The playerglobal branch `fix/offstage-coordinate-conversion` initializes the
view nodes from the display tree root before returning a node for coordinate
and bounds queries. It uses the view's node cache, rather than retaining a
separate adapter cache.

```sh
node scripts/check-coordinate-conversion.cjs
```

The regression uses actual scene containers and view nodes without rendering.
It covers child-first queries, precreated child nodes, movement, new offstage
parents, reparenting, scaling, reflection, and rotation. The original code fails
the first conversion. Browser validation with AQW's actual `AvatarMC.scale`
reproduces y=-488 before the fix and consistently gets y=-138 afterward, both
before and after attaching the avatar. Authenticated room transitions remain
the user's integration check.

## Chat input errors and blank speech bubbles

Three separate fixes are used together:

- Playerglobal `fix/text-metrics-keyboard-focus` implements
  `TextField.getCharBoundaries` by returning a Flash Rectangle from the scene's
  layout. Previously it always returned null, and AQW's `Chat.buildTextLinks`
  crashed at `m_buildTextLinks.js:822` when building clickable usernames.
- Scene `fix/text-character-bounds` reconstructs layout before metric queries,
  uses font height instead of a fixed 10 pixels, and maintains original text
  indices across explicit line breaks and wrapping. It also clears old character
  positions during width-only layout changes. `getLineIndexOfChar` previously
  had an uninitialized loop counter and effectively always selected the last line.
- Renderer `fix/alpha-premultiplication` saturates the final fragment alpha
  before multiplying RGB by alpha. AQW's `Chat.popBubble` sets `bubble.alpha`
  to 100. The old shader washed out the cached text at that value. The ActionScript
  property remains unchanged; clamping happens after the shader's color transform.

Keyboard events are adapted once per DOM event and Flash stage, dispatched from
its focused object, then bubbled normally. Unrelated and detached login/search
fields no longer receive chat keystrokes. Stale detached focus is cleared, and
`keypress` no longer duplicates `keyDown`/`keyUp`.

```sh
node scripts/check-text-metrics.cjs
node scripts/check-keyboard-focus.cjs
node scripts/check-text-layout.cjs
node scripts/check-password-masking.cjs
npm run build:prod
```

Chrome validation called the real AQW `Chat.buildTextLinks` with a synthetic
message: the original bundle reproduced the exact exception, while the fixed
bundle rendered the text and clickable username. A long username also rendered
across wrapped lines. A real `AvatarMC` bubble, configured using the game's
`popBubble` assignments, was blank at alpha 100 before the shader fix and readable
at the same alpha afterward. Browser key events reached the focused input and
its ancestors once each; another field and a detached field received none.
No messages were sent to the game server during these checks.

The separate map `frame8` and equipment `frame1` initialization errors in the
same log are not addressed by these chat fixes. Authenticated chat and room
transitions remain integration checks for the running game.

## Loading callback freeze, invalid vertex attributes, and symbol batches

The hair-completion exception in the captured log escaped
`LoaderInfoCompleteQueue.executeQueue`, then `Stage.enterFrame`. AwayJS's RAF
helper only schedules its next callback after the current callback returns, so
this stopped the animation loop permanently. Playerglobal's local
`fix/loader-completion-errors` branch catches and reports errors at the
asynchronous COMPLETE boundary. Other completions and later frames continue.
Callbacks added during dispatch are retained for a later frame rather than
being discarded when the old queue is cleared. This does not repair the game's
stale avatar reference; it prevents that script failure from killing the player.

The local Stage checkout starts at upstream `v0.11.172`, matching the installed
package. Its `fix/inactive-vertex-attributes` branch skips optimized-out shader
inputs (location -1) and uses the mapped WebGL location when disabling inputs.
The player aliases this checkout and enables legacy TypeScript decorators for
its filter classes. To recreate the base checkout in a fresh workspace:

```sh
git clone --branch v0.11.172 https://github.com/awayjs/stage.git ../stage
```

The local fix must also be applied; it has not been pushed upstream.

SWF-loader's `perf/yield-symbol-decoding` branch keeps symbol creation ordered
but yields to the browser after approximately 8 ms of work. Finalization and
COMPLETE wait for all symbols and the root timeline. Parser state prevents the
RAF parser tick from restarting a suspended decode, and decoding flags are
restored on failure. These are cooperative batches, not parallel workers:
fonts, symbol references, timelines, and factory registration share mutable
state. Individual expensive symbols and root-timeline creation can still exceed
the budget. Worker parallelism would require a separate, transferable geometry
phase before ordered asset creation; no throughput speedup is claimed here.

```sh
node scripts/check-loading-stability.cjs
node scripts/check-symbol-batches.cjs
npm run build:prod
```

The first test uses the actual RAF implementation and a throwing completion
callback; the old queue fails, while the fixed version schedules subsequent
frames and retains newly queued work. It also verifies inactive and remapped
WebGL attributes. The second test checks event-loop yields, decoding order,
completion timing, and failure cleanup. Chrome validation injected a throwing
listener into a real hair-SWF load: another SWF still completed and 11 additional
Flash frames ran in the next 400 ms. The rebuilt AQW login screen renders.

### Resizing and subpixel cache bounds

Battleon's resize crash reproduced at a 2560x1440 window: cache
`instance_mc_3169` had clipped bounds of 0.209228515625 x 200.43017578125.
`Image2D` rounded that to 0 x 200, and texture creation threw. The uncaught
render exception stopped the RAF loop; resizing the canvas afterward cleared
its last frame, leaving black output without requiring a lost WebGL context.

`RendererBase` now rounds valid clipped bounds outward to integer pixels before
cache allocation. Empty intersections still skip rendering. Projection, cache
quad and texture dimensions use the same rounded rectangle, including when a
scaled parent's fractional position leaves less than half a pixel visible.

Stage also releases the MSAA target's owned resolve framebuffer/depth-stencil
storage, clears deleted framebuffer bindings and texture references, and makes
render-target disposal idempotent. Idle filter targets from previous viewport
sizes are disposed on resize and stage disposal; checked-out nested targets
remain valid until returned.

Checks:

```sh
node scripts/check-bitmap-filter-bounds.cjs
node scripts/check-render-target-lifetime.cjs
```

Both regressions fail against the previous source. In headless Chrome with real
Battleon assets and a mock World, the rebuilt player completed 1200x800,
1600x1000, 1920x1080, 2560x1440, DPR 2, and back to 1200x800 without a render
exception or a leftover render-target stack entry. Estimated GPU allocations
returned from about 649 MB at 2560x1440 to 469 MB at 1200x800, close to the
468 MB starting value. A 3840x2160 pass and return also completed with no WebGL
error or context loss (about 1084 MB peak, 469 MB after shrinking). These are
engine estimates, not measured driver memory. Software rendering was slow at
4K; this does not establish that the separate reported whole-browser freeze
while typing in chat is fixed. No authenticated server session was exercised.
