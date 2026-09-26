import { Graphics, GraphicsFactoryFills, GraphicsFactoryStrokes } from '@awayjs/graphics';
import { Box } from '@awayjs/core';
import { AttributesBuffer } from '@awayjs/stage';
import { LineElements, TriangleElements } from '@awayjs/renderer';
import { DisplayObject, MorphSprite, SceneImage2D } from '@awayjs/scene';
import { installPathSource } from './path-source.mjs';
import { installMorphCache } from './morph-cache.mjs';
import { installCachedPickBounds } from './cached-pick-bounds.mjs';

// Loaded only by the experimental runtime, before any SWF assets are decoded.
window['__PIXI_FLASH_PATHS__'] = installPathSource(Graphics, GraphicsFactoryFills,
  GraphicsFactoryStrokes, Box, { AttributesBuffer, LineElements, DisplayObject, SceneImage2D });
if (new URLSearchParams(location.search).get('hairlines') === '0')
  window['__PIXI_FLASH_PATHS__'].setHairlinePixelLines(false);
if (new URLSearchParams(location.search).get('morphNativePaths') === '1')
  window['__PIXI_FLASH_PATHS__'].setMorphLiteGeometry(true);
const params = new URLSearchParams(location.search);
if (params.get('morphCache') === '1')
  window['__PIXI_MORPH_CACHE__'] = installMorphCache(MorphSprite, Graphics, {
    limit: Number(params.get('morphCacheLimit')) || undefined,
    budget: params.has('morphCacheMB') ? Number(params.get('morphCacheMB')) * 1024 * 1024 : undefined,
    steps: Number(params.get('morphCacheSteps')) || 0,
  });
if (new URLSearchParams(location.search).get('cachedPickBounds') === '1')
  window['__PIXI_PICK_BOUNDS_CACHE__'] = installCachedPickBounds(TriangleElements, Box);
