import { FillGradient, Graphics, GraphicsContext, GraphicsPath, Matrix, Rectangle, Sprite } from 'pixi.js';
import { retirePixiTexture } from './retire-pixi-texture.mjs';

function gradientStops(stops) {
  return stops.map(({ offset, color, alpha }) => ({ offset,
    color: `#${color.toString(16).padStart(6, '0')}${Math.round(alpha * 255).toString(16).padStart(2, '0')}` }));
}

function createGradient({ type, stops, uv }) {
  if (type === 'radial') {
    const [a, b, c, d, tx, ty] = uv, half = 128;
    const gradient = new FillGradient({ type: 'radial', textureSpace: 'global',
      center: { x: 0.5, y: 0.5 }, outerRadius: 0.5,
      colorStops: gradientStops(stops) });
    // Flash UVs map object coordinates to [-1, 1]^2. Pixi's radial atlas
    // samples [0, 256]^2, so invert that affine object-to-atlas mapping.
    gradient.buildGradient();
    gradient.transform = new Matrix(a * half, b * half, c * half, d * half,
      (tx + 1) * half, (ty + 1) * half).invert();
    return gradient;
  }
  const [a, , c, , tx] = uv;
  const unit = a * a + c * c;
  const point = t => ({ x: a * (t - tx) / unit, y: c * (t - tx) / unit });
  return new FillGradient({ type: 'linear', textureSpace: 'global',
    start: point(0), end: point(1),
    colorStops: gradientStops(stops) });
}

function bitmapMatrix({ uv, width, height }) {
  const [a, b, c, d, tx, ty] = uv, det = a * d - b * c;
  // AwayFL stores object -> normalized UV. Pixi expects bitmap-pixel ->
  // object and applies its own source-size normalization internally.
  return new Matrix(d / det / width, -b / det / width,
    -c / det / height, a / det / height,
    (c * ty - d * tx) / det, (b * tx - a * ty) / det);
}

function pathSegments(path) {
  if (path.segments) return path.segments;
  // Hand-authored fixtures may not pass through the SWF path source.
  let offset = 0;
  return (path.commands || []).map(command => {
    const size = command === 3 ? 4 : command === 6 ? 6 : 2;
    return { command, args: path.data.slice(offset, offset += size) };
  });
}

function contourPaths(path) {
  const contours = [];
  let current;
  for (const { command, args } of pathSegments(path)) {
    if (command === 1) {
      if (current) current.closePath();
      current = new GraphicsPath();
      current.moveTo(...args); contours.push(current);
    } else if (command === 2) current.lineTo(...args);
    else if (command === 3) current.quadraticCurveTo(...args);
    else current.bezierCurveTo(...args);
  }
  current?.closePath();
  return contours;
}

// Pixi's signed compound path handles one hole, but its hole grouping does not
// restore islands nested inside that hole. Build a containment tree instead.
// Ambiguous intersecting contours stay on the AwayFL mesh path.
function nestedContours(path) {
  const contours = contourPaths(path);
  const regions = contours.map((contour, index) => {
    const primitives = contour.shapePath.shapePrimitives;
    if (primitives.length !== 1 || primitives[0].shape.type !== 'polygon') return null;
    const polygon = primitives[0].shape, points = polygon.points;
    if (points.length < 6) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < points.length; i += 2) {
      minX = Math.min(minX, points[i]); maxX = Math.max(maxX, points[i]);
      minY = Math.min(minY, points[i + 1]); maxY = Math.max(maxY, points[i + 1]);
    }
    return { contour, polygon, index, box: { minX, minY, maxX, maxY },
      area: (maxX - minX) * (maxY - minY), parent: null, children: [] };
  });
  if (regions.some(region => !region)) return null;
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    const a = regions[i], b = regions[j];
    if (a.box.maxX <= b.box.minX || b.box.maxX <= a.box.minX ||
        a.box.maxY <= b.box.minY || b.box.maxY <= a.box.minY) continue;
    const aContains = a.polygon.containsPolygon(b.polygon);
    const bContains = b.polygon.containsPolygon(a.polygon);
    if (aContains === bContains) return null;
    const outer = aContains ? a : b, inner = aContains ? b : a;
    if (!inner.parent || outer.area < inner.parent.area) inner.parent = outer;
  }
  for (const region of regions) if (region.parent) region.parent.children.push(region);
  return regions.filter(region => !region.parent);
}

// One authored path -> one immutable GraphicsContext. An opt-in detailed-path
// cache may also create one shared texture; instances own only transform/paint.
// No clear(), triangle conversion or per-frame hashing.
export function createNativePaths(stats, renderer, { shapeSprites = false, retain = 4096 } = {}) {
  const entries = new Map();
  const contourPlans = new WeakMap();
  // Unused vector contexts, oldest first. Morphs and timeline swaps return to
  // the same authored path a few frames later; rebuilding it each time costs
  // more than keeping a bounded set alive.
  const unused = new Map();
  const retained = Math.max(0, retain | 0);
  stats.nativePathRetained = stats.nativePathRevivals = 0;
  stats.nativeGraphics = stats.nativeGradients = stats.nativeBitmaps = stats.nativeCompounds = stats.nativePathBuilds = stats.nativePathShares = 0;
  stats.shapeSpriteBuilds = stats.shapeSpriteUses = stats.shapeSpritePixels = stats.shapeSpriteRejected = 0;
  const resolution = 2, pixelBudget = 8_000_000;
  function maybeRasterize(entry) {
    if (!shapeSprites || entry.rasterTried) return;
    entry.rasterTried = true;
    const path = entry.path;
    if (!path.rasterStable || path.stroke || path.gradient || path.bitmap || pathSegments(path).length < 80) return;
    const graphics = new Graphics(entry.context);
    try {
      const bounds = graphics.getLocalBounds();
      const width = Math.ceil(bounds.width * resolution);
      const height = Math.ceil(bounds.height * resolution);
      const pixels = width * height;
      if (!(width > 0 && height > 0 && width <= 1024 && height <= 1024 &&
          pixels <= 400_000 && stats.shapeSpritePixels + pixels <= pixelBudget)) {
        stats.shapeSpriteRejected++;
        return;
      }
      entry.rasterTexture = renderer.generateTexture({ target: graphics,
        frame: new Rectangle(bounds.x, bounds.y, bounds.width, bounds.height),
        resolution, antialias: true });
      entry.rasterBounds = [bounds.x, bounds.y];
      entry.rasterPixels = pixels;
      stats.shapeSpritePixels += pixels;
      stats.shapeSpriteBuilds++;
    } catch (error) {
      // A failed offscreen render must never hide the original vector shape.
      stats.shapeSpriteRejected++;
    } finally {
      graphics.destroy();
    }
  }
  function contourPlan(path) {
    if (path.stroke || path.contours <= 1) return true;
    if (!contourPlans.has(path)) contourPlans.set(path, nestedContours(path) || false);
    return contourPlans.get(path);
  }
  function fillStyle(path, texture) {
    if (path.gradient) return { fill: createGradient(path.gradient) };
    if (path.bitmap) return { texture, textureSpace: 'global', matrix: bitmapMatrix(path.bitmap) };
    return 0xffffff;
  }
  function acquire(path, texture) {
    let entry = entries.get(path);
    if (!entry) {
      const context = new GraphicsContext();
      // Every multi-contour fill goes through the containment tree with explicit
      // holes. Pixi's signed compound path missed holes whose contour winding
      // matches the outer one (a chest frame drew solid over its planks).
      const regions = !path.stroke && path.contours > 1;
      const drawing = context;
      let startX, startY, endX, endY, hasSegment = false;
      const closeStroke = () => {
        if (path.stroke && hasSegment && startX === endX && startY === endY)
          context.closePath();
      };
      if (path.primitive) {
        const { kind, args } = path.primitive;
        if (kind === 'rect') context.rect(...args);
        else if (kind === 'circle') context.circle(...args);
        else if (kind === 'roundRect') context.roundRect(...args);
        else if (kind === 'ellipse') {
          const [x, y, width, height] = args;
          context.ellipse(x + width / 2, y + height / 2, width / 2, height / 2);
        }
      }
      if (!regions) for (const { command, args } of pathSegments(path)) {
        if (command === 1) {
          closeStroke(); drawing.moveTo(...args);
          [startX, startY] = args; hasSegment = false;
        }
        else if (command === 2) drawing.lineTo(...args);
        else if (command === 3) drawing.quadraticCurveTo(...args);
        else drawing.bezierCurveTo(...args);
        [endX, endY] = args.slice(-2);
        if (command !== 1) hasSegment = true;
      }
      let gradient;
      if (path.stroke) {
        closeStroke();
        context.stroke({ ...path.stroke, color: 0xffffff, alignment: 0.5 });
      } else if (regions) {
        const roots = contourPlan(path);
        const paint = fillStyle(path, texture);
        gradient = path.gradient ? paint.fill : null;
        const drawRegion = region => {
          context.beginPath().path(region.contour).fill(paint);
          for (const child of region.children)
            context.beginPath().path(child.contour).cut();
          for (const child of region.children)
            for (const island of child.children) drawRegion(island);
        };
        for (const root of roots) drawRegion(root);
      } else if (path.gradient) {
        gradient = createGradient(path.gradient);
        context.closePath().fill({ fill: gradient });
      } else if (path.bitmap) {
        context.closePath().fill({ texture, textureSpace: 'global',
          matrix: bitmapMatrix(path.bitmap) });
      } else context.closePath().fill(0xffffff);
      entry = { path, context, gradient, texture, users: 0 };
      entries.set(path, entry); stats.nativePathBuilds++;
    } else {
      stats.nativePathShares++;
      if (!entry.users && unused.delete(entry)) stats.nativePathRevivals++;
    }
    entry.users++;
    maybeRasterize(entry);
    if (entry.rasterTexture) {
      const sprite = new Sprite(entry.rasterTexture);
      sprite.position.set(...entry.rasterBounds);
      stats.shapeSpriteUses++;
      return { entry, graphics: sprite };
    }
    return { entry, graphics: new Graphics(entry.context) };
  }
  return {
    supports(path) { return !!path.primitive || !!contourPlan(path); },
    acquire,
    release(entry) {
      // Texture-backed entries follow their texture's lifetime instead.
      if (--entry.users || !retained || entry.texture || entry.rasterTexture) return;
      unused.set(entry, true);
    },
    usesTexture(texture) {
      for (const entry of entries.values())
        if (entry.users && entry.texture === texture) return true;
      return false;
    },
    sweep() {
      const retire = entry => {
        if (entry.rasterTexture) {
          retirePixiTexture(entry.rasterTexture);
          stats.shapeSpritePixels -= entry.rasterPixels;
        }
        entry.context.destroy();
        if (entry.gradient) { retirePixiTexture(entry.gradient.texture); entry.gradient.destroy(); }
        entries.delete(entry.path);
      };
      for (const entry of entries.values())
        if (!entry.users && !unused.has(entry)) retire(entry);
      for (const entry of unused.keys()) {
        if (unused.size <= retained) break;
        unused.delete(entry);
        retire(entry);
      }
      stats.nativePathRetained = unused.size;
    },
    destroy() {
      for (const e of entries.values()) {
        if (e.rasterTexture) retirePixiTexture(e.rasterTexture);
        e.context.destroy();
        if (e.gradient) { retirePixiTexture(e.gradient.texture); e.gradient.destroy(); }
      }
      entries.clear();
      unused.clear();
      stats.nativePathRetained = 0;
      stats.shapeSpritePixels = 0;
    },
  };
}
