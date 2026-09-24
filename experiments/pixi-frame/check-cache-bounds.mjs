import assert from "node:assert/strict";
import { projectCacheBounds } from "./cache-bounds.mjs";

// An authored rectangle must remain aligned with an unfiltered sibling after
// resizing above CacheRenderer's 3x raster cap, including a viewport offset.
for (const screenScale of [1.5, 3, 3.5, 4.2]) {
  const scale = Math.min(3, screenScale);
  const width = 960 * screenScale,
    height = 550 * screenScale;
  const offset = { x: 17, y: 23 };
  const matrix = [
    2 / 960,
    0,
    0,
    0,
    0,
    -2 / 550,
    0,
    0,
    0,
    0,
    1,
    0,
    -1 + (offset.x * 2) / width,
    1 - (offset.y * 2) / height,
    0,
    1,
  ];
  const result = projectCacheBounds(
    { x: 120 * scale, y: 400 * scale, width: 80 * scale, height: 20 * scale },
    scale,
    matrix,
    width,
    height,
  );
  for (const [key, expected] of Object.entries({
    x: 120 * screenScale + offset.x,
    y: 400 * screenScale + offset.y,
    width: 80 * screenScale,
    height: 20 * screenScale,
  }))
    assert.ok(
      Math.abs(result[key] - expected) < 1e-9,
      `${screenScale}: ${key}`,
    );
}
console.log(
  "Cache projection checks passed below and above the raster scale cap.",
);
