// Prepare authored commands once at the decoder/factory boundary. Keep this
// independent of AwayFL's triangle geometry so Pixi can eventually use it
// without forcing the native renderer to tessellate a shape first.
function pathBounds(segments) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const include = (x, y) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  const evaluate = (points, t) => {
    let values = points.slice();
    while (values.length > 1) values = values.slice(1).map((value, i) =>
      values[i] * (1 - t) + value * t);
    return values[0];
  };
  const extrema = points => {
    if (points.length === 3) {
      const denominator = points[0] - 2 * points[1] + points[2];
      return denominator ? [(points[0] - points[1]) / denominator] : [];
    }
    const a = -points[0] + 3 * points[1] - 3 * points[2] + points[3];
    const b = 2 * (points[0] - 2 * points[1] + points[2]);
    const c = points[1] - points[0];
    if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b];
    const discriminant = b * b - 4 * a * c;
    return discriminant < 0 ? [] : [(-b - Math.sqrt(discriminant)) / (2 * a),
      (-b + Math.sqrt(discriminant)) / (2 * a)];
  };
  let x = 0, y = 0;
  for (const segment of segments) {
    const { command, args } = segment;
    if (command === 1 || command === 2) {
      [x, y] = args; include(x, y);
      continue;
    }
    const xs = command === 3 ? [x, args[0], args[2]] : [x, args[0], args[2], args[4]];
    const ys = command === 3 ? [y, args[1], args[3]] : [y, args[1], args[3], args[5]];
    include(x, y);
    include(xs.at(-1), ys.at(-1));
    for (const t of [...extrema(xs), ...extrema(ys)])
      if (t > 0 && t < 1) include(evaluate(xs, t), evaluate(ys, t));
    x = xs.at(-1); y = ys.at(-1);
  }
  return Object.freeze({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
}

function snapshotCommands(path, minimum, maxContours = Infinity) {
  if (path.morphSource || path.verts?.length || !Array.isArray(path.commands) ||
      !Array.isArray(path.data) || path.commands.length < minimum) return null;
  const sizes = { 1: 2, 2: 2, 3: 4, 6: 6 };
  let size = 0, moves = 0;
  const segments = [];
  for (const command of path.commands) {
    if (!sizes[command]) return null;
    const args = Object.freeze(path.data.slice(size, size + sizes[command]));
    segments.push(Object.freeze({ command, args }));
    size += sizes[command];
    if (command === 1) moves++;
  }
  if (moves < 1 || moves > maxContours ||
      path.commands[0] !== 1 || size !== path.data.length ||
      !path.data.every(Number.isFinite)) return null;
  return { contours: moves, commands: Object.freeze(Array.from(path.commands)),
    data: Object.freeze(Array.from(path.data)), segments: Object.freeze(segments),
    bounds: pathBounds(segments) };
}

export function snapshotSolidPath(path) {
  const fill = path.style?.fillStyle;
  if (path.style?.data_type !== '[graphicsdata FillStyle]' ||
      fill?.data_type !== '[graphicsdata SolidFillStyle]' || !Number.isFinite(fill.alpha)) return null;
  const data = snapshotCommands(path, 3);
  return data && Object.freeze({ ...data, color: fill.color, alpha: fill.alpha });
}

export function snapshotGradientPath(path) {
  const fill = path.style?.fillStyle;
  if (path.style?.data_type !== '[graphicsdata FillStyle]' ||
      fill?.data_type !== '[graphicsdata GradientFillStyle]' ||
      !['linear', 'radial'].includes(fill.type) ||
      (fill.type === 'radial' && fill.focalPointRatio != null &&
        (!Number.isFinite(fill.focalPointRatio) || Math.abs(fill.focalPointRatio) > 1e-6)) ||
      ![null, undefined, 'pad'].includes(fill.spreadMethod) ||
      ![null, undefined, 'rgb'].includes(fill.interpolationMethod)) return null;
  const data = snapshotCommands(path, 3);
  const { colors_r: r, colors_g: g, colors_b: b, alphas, ratios } = fill;
  if (!data || !r?.length || r.length !== g?.length || r.length !== b?.length ||
      r.length !== alphas?.length || r.length !== ratios?.length ||
      !alphas.every(a => Number.isFinite(a) && a >= 0 && a <= 1) ||
      !ratios.every(a => Number.isFinite(a) && a >= 0 && a <= 255)) return null;
  const stops = ratios.map((ratio, i) => Object.freeze({ offset: ratio / 255,
    color: ((r[i] & 255) << 16) | ((g[i] & 255) << 8) | (b[i] & 255),
    alpha: alphas[i] }));
  return Object.freeze({ ...data, gradient: Object.freeze({ type: fill.type,
    stops: Object.freeze(stops) }) });
}

export function snapshotBitmapFill(path) {
  const fill = path.style?.fillStyle;
  // Pixi Graphics forces repeat sampling for texture fills. Flash's
  // non-repeating edge clamp must continue through the mesh renderer.
  if (path.style?.data_type !== '[graphicsdata FillStyle]' ||
      fill?.data_type !== '[graphicsdata BitmapFillStyle]' || !fill.repeat ||
      !fill.image || !(fill.image.width > 0) || !(fill.image.height > 0)) return null;
  const data = snapshotCommands(path, 3);
  return data && Object.freeze({ ...data, bitmap: Object.freeze({ image: fill.image,
    width: fill.image.width, height: fill.image.height, smooth: !!fill.smooth }) });
}

function attachPaintUV(path, style) {
  if (!path?.gradient && !path?.bitmap) return path;
  const uv = style?.uvMatrix;
  const matrix = uv && [uv.a, uv.b, uv.c, uv.d, uv.tx, uv.ty];
  if (!matrix?.every(Number.isFinite)) return null;
  if (path.bitmap) {
    if (Math.abs(uv.a * uv.d - uv.b * uv.c) < 1e-12) return null;
    return Object.freeze({ ...path,
      bitmap: Object.freeze({ ...path.bitmap, uv: Object.freeze(matrix) }) });
  }
  if (path.gradient.type === 'radial' ?
      Math.abs(uv.a * uv.d - uv.b * uv.c) < 1e-12 :
      !(uv.a * uv.a + uv.c * uv.c > 0)) return null;
  return Object.freeze({ ...path,
    gradient: Object.freeze({ ...path.gradient, uv: Object.freeze(matrix) }) });
}

// Hairlines become Pixi pixelLine strokes unless disabled for comparison.
let hairlinePixelLines = true;
export function setHairlinePixelLines(enabled) { hairlinePixelLines = !!enabled; }

export function snapshotStrokePath(path) {
  const style = path.style;
  // Normal scaling maps directly to Pixi. A Flash hairline is one device pixel
  // at any scale, which is exactly Pixi's pixelLine stroke. Other non-scaling
  // strokes keep a screen-space width and stay on the mesh path.
  // The SWF decoder marks widths up to 0.05 as hairlines; the script bridge
  // drops the scale mode, so apply the same width rule here.
  const hairline = style?.scaleMode === 4 || (style?.thickness > 0 && style.thickness <= 0.05);
  if (style?.data_type !== '[graphicsdata StrokeStyle]' || (style.scaleMode !== 2 && !hairline) || (hairline && !hairlinePixelLines) ||
      !(style.thickness > 0) || !Number.isFinite(style.thickness) ||
      !(style.miterLimit > 0) || !Number.isFinite(style.miterLimit)) return null;
  // SWF decoding supplies enums; script lineStyle calls can supply strings.
  const cap = style.capstyle == null ? 'round' :
    ({none:'butt',round:'round',square:'square'}[style.capstyle] || ['butt', 'round', 'square'][style.capstyle]);
  const join = style.jointstyle == null ? 'round' :
    ({round:'round',bevel:'bevel',miter:'miter'}[style.jointstyle] || ['round', 'bevel', 'miter'][style.jointstyle]);
  if (style.fillStyle?.data_type !== '[graphicsdata SolidFillStyle]' ||
      !Number.isFinite(style.fillStyle.alpha)) return null;
  const data = snapshotCommands(path, 2);
  if (!data || !['butt','round','square'].includes(cap) || !['round','bevel','miter'].includes(join)) return null;
  return Object.freeze({ ...data, color: style.fillStyle.color, alpha: style.fillStyle.alpha,
    stroke: Object.freeze(hairline
      ? { width: 1, pixelLine: true, cap, join, miterLimit: style.miterLimit }
      : { width: style.thickness, cap, join, miterLimit: style.miterLimit }),
  });
}

function snapshotPrimitiveFill(path, primitive) {
  // The fill factory receives triangles for Graphics.draw* calls. Recover the
  // authored primitive while preserving the same paint eligibility rules as
  // command paths, including the bitmap/gradient UV checks at attachment.
  const paintPath = { style: path.style, verts: [], commands: [1, 2, 2],
    data: [0, 0, 1, 0, 1, 1] };
  const paint = snapshotSolidPath(paintPath) || snapshotGradientPath(paintPath) ||
    snapshotBitmapFill(paintPath);
  if (!paint) return null;
  const [x, y, width, height] = primitive.args;
  const bounds = primitive.kind === 'circle'
    ? { x: x - width, y: y - width, width: width * 2, height: width * 2 }
    : { x, y, width, height };
  return Object.freeze({ ...paint, primitive: Object.freeze(primitive),
    commands: undefined, data: undefined, segments: undefined,
    bounds: Object.freeze(bounds) });
}

export function installPathSource(Graphics, Factory, Strokes, Box, runtime = {}) {
  const sources = new WeakMap();
  const primitives = new WeakMap();
  // SWF records are serialized into GraphicsPath objects once per symbol.
  // Save their authored commands there, before AwayFL prepares/tessellates the
  // path. Script-created GraphicsPath objects still use the factory fallback.
  const definitions = new WeakMap();
  const lazyByBuffer = new WeakMap();
  const activeByBuffer = new WeakMap();
  const lazyByElements = new Map();
  const { AttributesBuffer, LineElements, DisplayObject, SceneImage2D } = runtime;
  const lazyStats = { skipped: 0, materialized: 0, live: 0,
    skippedStrokes: 0, materializedStrokes: 0, liveStrokes: 0,
    morphSkipped: 0, morphMaterialized: 0 };
  let lazyEnabled = false;
  let morphLazyEnabled = false;
  let bitmapDrawHandler = null;
  let guardId = 0;
  let pending = null, pendingAuthored = false, capturing = false, currentGraphics = null;
  const draw = Factory.draw_pathes, convert = Factory.pathToAttributesBuffer;
  const add = Graphics.prototype.addShapeInternal;
  const convertRecords = Graphics.prototype.convertRecordsToShapeData;
  const queuePath = Graphics.prototype.add_queued_path;
  function restoreElementHooks(record) {
    for (const [name, descriptor] of record.descriptors) {
      if (descriptor) Object.defineProperty(record.elements, name, descriptor);
      else delete record.elements[name];
    }
    record.descriptors.clear();
  }
  function releaseLazyRecord(record) {
    if (record.released) return;
    record.released = true;
    if (!record.materialized) {
      lazyStats.live--;
      if (record.stroke) lazyStats.liveStrokes--;
    }
    restoreElementHooks(record);
    if (activeByBuffer.get(record.elements.positions?.attributesBuffer) === record)
      activeByBuffer.delete(record.elements.positions.attributesBuffer);
    if (lazyByElements.get(record.elements) === record) lazyByElements.delete(record.elements);
    record.elements.removeAbstraction(record.lifeGuard);
  }
  function materialize(record) {
    if (record.materialized || record.materializing) return;
    if (record.shape?.elements !== record.elements) {
      releaseLazyRecord(record);
      return;
    }
    record.materializing = true;
    try {
      const elements = record.elements;
      if (record.stroke) {
        record.stroke.lines.call(Strokes, [record.path], false,
          record.stroke.scaleMode, elements);
      } else {
        const target = elements.positions.attributesBuffer;
        const result = convert.call(Factory, record.path, false, target);
        elements._numVertices = result.count;
      }
      elements.invalidate();
      record.materialized = true;
      lazyStats.materialized++;
      if (record.morph) lazyStats.morphMaterialized++;
      lazyStats.live--;
      if (record.stroke) {
        lazyStats.materializedStrokes++;
        lazyStats.liveStrokes--;
      }
    } finally { record.materializing = false; }
  }
  function materializeAll() {
    for (const record of [...lazyByElements.values()]) {
      if (record.morph && record.shape?.usages === 0) releaseLazyRecord(record);
      else materialize(record);
    }
  }
  function prepareRecycled(record) {
    if (!record || record.materialized) return;
    // Graphics.clear() may pool a morph Shape and reuse its buffer for the
    // next ratio. Its previous geometry is no longer observable in that case.
    if (record.morph && record.shape?.usages === 0) releaseLazyRecord(record);
    else materialize(record);
  }
  function installElementHooks(record) {
    for (const name of ['hitTestPoint', 'applyTransformation', 'scale', 'prepareScale9']) {
      const original = record.elements[name];
      if (typeof original !== 'function') continue;
      record.descriptors.set(name, Object.getOwnPropertyDescriptor(record.elements, name));
      Object.defineProperty(record.elements, name, { configurable: true,
        value: function (...args) {
          materialize(record);
          return original.apply(this, args);
        } });
    }
  }
  function boundingTriangles(path, target) {
    const { x, y, width, height } = path.bounds;
    const buffer = target || new AttributesBuffer(8, 6);
    buffer.count = 6;
    new Float32Array(buffer.buffer).set([
      x, y, x + width, y, x + width, y + height,
      x, y, x + width, y + height, x, y + height,
    ]);
    buffer.invalidate();
    return buffer;
  }
  if (SceneImage2D && DisplayObject) {
    const originalDraw = SceneImage2D.prototype.draw;
    SceneImage2D.prototype.draw = function (source, ...args) {
      if (lazyEnabled && source instanceof DisplayObject && bitmapDrawHandler?.(this, source, ...args))
        return;
      if (lazyEnabled && source instanceof DisplayObject) materializeAll();
      return originalDraw.call(this, source, ...args);
    };
  }
  for (const [method, kind] of [['drawRect', 'rect'], ['drawCircle', 'circle'],
    ['drawEllipse', 'ellipse'], ['drawRoundRect', 'roundRect']]) {
    const original = Graphics.prototype[method];
    if (!original) continue;
    Graphics.prototype[method] = function (...args) {
      const path = this._active_fill_path;
      const empty = path && !path.morphSource && !path.verts?.length &&
        Array.isArray(path.commands) && path.commands.every(c => c === 1) &&
        Array.isArray(path.data) && path.data.length === 2 * path.commands.length;
      const result = original.apply(this, args);
      if (path) {
        primitives.delete(path);
        // AwayFL defaults ellipseHeight to ellipseWidth. Pixi's roundRect has
        // one circular corner radius, so elliptical corners stay as meshes.
        const radius = args[4] / 2;
        const defaultHeight = args.length < 6 || args[5] == null || Number.isNaN(args[5]);
        const cornerHeight = defaultHeight ? args[4] : args[5];
        const valid = kind === 'roundRect'
          ? args.slice(0, 5).every(Number.isFinite) &&
            (defaultHeight || Number.isFinite(args[5])) &&
            args[2] > 0 && args[3] > 0 && args[4] >= 0 &&
            cornerHeight === args[4] && radius <= Math.min(args[2], args[3]) / 2
          : args.every(Number.isFinite) &&
            (kind === 'rect' ? args[2] > 0 && args[3] > 0 :
              kind === 'circle' ? args[2] > 0 : args[2] > 0 && args[3] > 0);
        // Stroke geometry remains on its existing path. The fill is inset by
        // AwayFL when a stroke is active, so defer that combination for now.
        if (empty && valid && !this._active_stroke_path &&
            this._active_fill_path === path && path.verts?.length) {
          const pixiArgs = kind === 'roundRect' ? [...args.slice(0, 4), radius] : args;
          const primitive = { kind, args: Object.freeze(Array.from(pixiArgs)) };
          const snapshot = snapshotPrimitiveFill(path, primitive);
          if (snapshot) primitives.set(path, { snapshot, style: path.style,
            dirty: path._dirtyID, commandCount: path.commands.length,
            dataCount: path.data.length, vertsCount: path.verts.length });
        }
      }
      return result;
    };
  }
  const primitivePath = path => {
    const saved = primitives.get(path);
    return saved && saved.style === path.style && saved.dirty === path._dirtyID &&
      saved.commandCount === path.commands.length && saved.dataCount === path.data.length &&
      saved.vertsCount === path.verts.length ? saved.snapshot : null;
  };
  const definitionPath = path => {
    const saved = definitions.get(path);
    return saved && saved.style === path.style && saved.dirty === path._dirtyID &&
      saved.commandCount === path.commands.length && saved.dataCount === path.data.length
      ? saved.snapshot : undefined;
  };
  if (convertRecords && queuePath) {
    let defining = 0;
    Graphics.prototype.convertRecordsToShapeData = function (...args) {
      defining++;
      try { return convertRecords.apply(this, args); }
      finally { defining--; }
    };
    Graphics.prototype.add_queued_path = function (path, ...args) {
      if (defining && path && !definitions.has(path)) {
        const snapshot = snapshotSolidPath(path) || snapshotGradientPath(path) ||
          snapshotBitmapFill(path) || snapshotStrokePath(path);
        definitions.set(path, { snapshot, style: path.style, dirty: path._dirtyID,
          commandCount: path.commands.length, dataCount: path.data.length });
      }
      return queuePath.call(this, path, ...args);
    };
  }
  Factory.draw_pathes = function (...args) {
    const previous = [pending, pendingAuthored, capturing, currentGraphics];
    pending = null; pendingAuthored = false; capturing = true; currentGraphics = args[0];
    try { return draw.apply(this, args); }
    finally { [pending, pendingAuthored, capturing, currentGraphics] = previous; }
  };
  Factory.pathToAttributesBuffer = function (path, ...args) {
    const definition = capturing ? definitionPath(path) : null;
    if (capturing) pendingAuthored = !!definition;
    if (capturing) pending = primitivePath(path) || definition ||
      (snapshotSolidPath(path) || snapshotGradientPath(path) || snapshotBitmapFill(path));
    const old = args[1] && activeByBuffer.get(args[1]);
    prepareRecycled(old);
    const morph = morphLazyEnabled && currentGraphics?._clearCount > 0 &&
      currentGraphics?.start?.length && currentGraphics?.end?.length;
    const deferred = definition || (morph ? pending : null);
    if (lazyEnabled && AttributesBuffer && deferred && !deferred.stroke &&
        deferred.bounds.width > 0 && deferred.bounds.height > 0 &&
        (definition ? currentGraphics?._clearCount === 0 : morph) &&
        !path.verts?.length) {
      const buffer = boundingTriangles(deferred, args[1]);
      lazyByBuffer.set(buffer, { path, snapshot: deferred, morph: !!morph });
      lazyStats.skipped++;
      if (morph) lazyStats.morphSkipped++;
      return buffer;
    }
    return convert.call(this, path, ...args);
  };
  if (Strokes) {
    const drawStrokes = Strokes.draw_pathes, lines = Strokes.fillLineElements;
    Strokes.draw_pathes = function (...args) {
      const previous = [pending, pendingAuthored, capturing, currentGraphics];
      pending = null; pendingAuthored = false; capturing = true; currentGraphics = args[0];
      try { return drawStrokes.apply(this, args); }
      finally { [pending, pendingAuthored, capturing, currentGraphics] = previous; }
    };
    Strokes.fillLineElements = function (paths, ...args) {
      const definition = capturing && paths.length === 1 ? definitionPath(paths[0]) : null;
      if (capturing) pending = paths.length === 1 ?
        (definition ?? snapshotStrokePath(paths[0])) : null;
      const morph = morphLazyEnabled && currentGraphics?._clearCount > 0 &&
        currentGraphics?.start?.length && currentGraphics?.end?.length;
      const deferred = definition || (morph ? pending : null);
      if (lazyEnabled && AttributesBuffer && LineElements && deferred?.stroke &&
          args[0] === false && (args[1] === 2 || (args[1] === 4 && deferred.stroke.pixelLine)) &&
          (deferred.bounds.width > 0 || deferred.bounds.height > 0) &&
          (definition ? currentGraphics?._clearCount === 0 : morph) &&
          !paths[0].verts?.length) {
        const path = paths[0];
        const elements = args[2] || new LineElements(new AttributesBuffer());
        const old = activeByBuffer.get(elements.positions.attributesBuffer);
        prepareRecycled(old);
        const { x, y, width, height } = deferred.bounds;
        elements.setPositions([x, y, 0, x + width, y + height, 0]);
        elements.setThickness([deferred.stroke.width / 2]);
        lazyByBuffer.set(elements.positions.attributesBuffer,
          { path, stroke: { lines, scaleMode: args[1] }, morph: !!morph });
        lazyStats.skipped++;
        lazyStats.skippedStrokes++;
        if (morph) lazyStats.morphSkipped++;
        return elements;
      }
      return lines.call(this, paths, ...args);
    };
  }
  Graphics.prototype.addShapeInternal = function (shape) {
    const elements = shape.elements;
    const buffer = elements.positions?.attributesBuffer;
    const lazy = lazyByBuffer.get(buffer);
    if (lazy) {
      let record = lazyByElements.get(elements);
      if (record) {
        if (!record.materialized) materialize(record);
        record.path = lazy.path;
        record.stroke = lazy.stroke;
        record.morph = lazy.morph;
        record.materialized = false;
        record.shape = shape;
      } else {
        record = { elements, shape, path: lazy.path, stroke: lazy.stroke,
          morph: lazy.morph,
          materialized: false,
          materializing: false, descriptors: new Map() };
        lazyByElements.set(elements, record);
        installElementHooks(record);
        record.lifeGuard = { id: 'pixi-lazy-elements-' + ++guardId,
          onInvalidate() {}, onClear() { releaseLazyRecord(record); } };
        elements.addAbstraction(record.lifeGuard);
      }
      activeByBuffer.set(buffer, record);
      lazyByBuffer.delete(buffer);
      lazyStats.live++;
      if (lazy.stroke) lazyStats.liveStrokes++;
    }
    const old = sources.get(elements);
    if (old) old.guard.onClear();
    if (capturing && pending) {
      const path = attachPaintUV(pending, shape.style);
      if (!path) {
        const deferred = lazyByElements.get(elements);
        if (deferred) materialize(deferred);
        pending = null;
        return add.call(this, shape);
      }
      // Only decoder-owned path definitions are eligible for shape textures.
      // Runtime Graphics drawing can be changed or cleared at any time.
      const source = { path: Object.freeze({ ...path,
        rasterStable: pendingAuthored }),
        material: shape.material, style: shape.style };
      // Pooling or later vertex edits must never reuse stale authored commands.
      const buffers = new Set([elements.positions?.attributesBuffer,
        elements.thickness?.attributesBuffer].filter(Boolean));
      const guard = { id: 'pixi-authored-path-' + ++guardId, onInvalidate() { this.onClear(); },
        onClear() {
          sources.delete(elements); elements.removeAbstraction(guard);
          for (const buffer of buffers) buffer.removeAbstraction(guard);
        } };
      source.guard = guard;
      sources.set(elements, source); elements.addAbstraction(guard);
      for (const buffer of buffers) buffer.addAbstraction(guard);
    }
    pending = null;
    pendingAuthored = false;
    return add.call(this, shape);
  };
  return {
    Box,
    lazyStats,
    setBitmapDrawHandler(handler) { bitmapDrawHandler = handler; },
    setMorphLiteGeometry(enabled) { morphLazyEnabled = !!enabled; },
    setHairlinePixelLines,
    setLiteGeometry(enabled) {
      if (!enabled) {
        lazyEnabled = false;
        materializeAll();
        for (const record of [...lazyByElements.values()]) releaseLazyRecord(record);
        lazyStats.live = 0;
        lazyStats.liveStrokes = 0;
      } else lazyEnabled = true;
    },
    get(shape) {
      const source = sources.get(shape.elements);
      return source && source.material === shape.material && source.style === shape.style &&
        !shape.offset && !shape.count ? source.path : null;
    },
    ensureGeometry(shape) {
      const record = shape?.elements && lazyByElements.get(shape.elements);
      if (record) materialize(record);
    },
    deferred(shape) {
      const record = shape?.elements && lazyByElements.get(shape.elements);
      return !!record && !record.materialized;
    },
  };
}
