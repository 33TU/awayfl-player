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
