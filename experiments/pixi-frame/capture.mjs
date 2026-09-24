/** Capture one AwayFL frame. All temporary hooks are restored synchronously. */
export function captureFrame(player, options = {}) {
  const root = player._renderer,
    stage = player._view.stage,
    context = stage.context,
    gl = context._gl;
  if (!gl.getBufferSubData)
    throw Error("The capture adapter currently requires WebGL 2.");
  const width = gl.drawingBufferWidth,
    height = gl.drawingBufferHeight;
  const restores = [],
    commands = [],
    draws = new Map(),
    masks = new Map(),
    sources = new Map();
  const buffers = new Map(),
    programs = options.programs || new Map(),
    textures = new Map(),
    targets = new Map(),
    boundTextures = new Map();
  const stats = {
    meshes: 0,
    cachedImages: 0,
    overlays: 0,
    masks: 0,
    triangles: 0,
    unsupported: [],
    directMeshes: 0,
    directCaches: 0,
    sourceMeshes: 0,
    sourceCacheQuads: 0,
    sourceMaskMeshes: 0,
    sourceBatches: 0,
    sourceFallbacks: {},
    directFallbacks: {},
    awayDraws: 0,
    pixiFilterPasses: 0,
    skippedSceneDraws: 0,
    skippedSceneClears: 0,
    skippedComposites: 0,
    skippedBackdropFlushes: 0,
  };
  let active = null,
    activeCache = null,
    recorded = 0,
    scenePass = false,
    backdropPass = false,
    pixiPass = false;
  const prepareOnly = !!options.prepareOnly;
  function hook(object, key, replacement) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    const old = object[key];
    object[key] = replacement(old);
    restores.push(() => {
      if (descriptor) Object.defineProperty(object, key, descriptor);
      else delete object[key];
    });
  }
  function owner(object, key) {
    while (object && !Object.hasOwn(object, key))
      object = Object.getPrototypeOf(object);
    if (!object) throw Error("Missing AwayFL hook: " + key);
    return object;
  }
  const base = owner(root, "applyTraversable");
  function texturePixels(texture, sampler = {}) {
    if (!texture) throw Error("Missing captured texture");
    if (options.transport) return options.transport.texture(texture);
    if (textures.has(texture)) return textures.get(texture);
    const w = texture.width ?? texture._width,
      h = texture.height ?? texture._height;
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const fb = gl.createFramebuffer();
    try {
      if (texture._renderTarget?.isMsaaTarget) texture._renderTarget.present();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        texture._glTexture,
        0,
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw Error("Texture readback framebuffer is incomplete");
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const result = {
        width: w,
        height: h,
        pixels,
        scaleMode: texture._state?.filter === gl.LINEAR ? "linear" : "nearest",
        addressMode:
          texture._state?.wrap === gl.REPEAT ? "repeat" : "clamp-to-edge",
        ...sampler,
      };
      textures.set(texture, result);
      return result;
    } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
      gl.deleteFramebuffer(fb);
    }
  }
  function sourcePixels(image, key, snapshot = false) {
    const texture = stage.abstractions.getAbstraction(image).getTexture();
    if (options.transport)
      return options.transport.texture(texture, snapshot ? key : undefined);
    // Temporary images may be reused later in this same capture.
    textures.delete(texture);
    return texturePixels(texture);
  }
  function bufferBytes(buffer) {
    if (options.transport) return options.transport.bufferBytes(buffer);
    if (buffers.has(buffer)) return buffers.get(buffer);
    const old = gl.getParameter(gl.COPY_READ_BUFFER_BINDING);
    gl.bindBuffer(gl.COPY_READ_BUFFER, buffer);
    const data = new Uint8Array(
      gl.getBufferParameter(gl.COPY_READ_BUFFER, gl.BUFFER_SIZE),
    );
    gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, data);
    gl.bindBuffer(gl.COPY_READ_BUFFER, old);
    buffers.set(buffer, data);
    return data;
  }
  function metadata(program) {
    if (programs.has(program)) return programs.get(program);
    const shader = {},
      attributes = [],
      uniforms = [];
    for (const s of gl.getAttachedShaders(program))
      shader[
        gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.VERTEX_SHADER
          ? "vertex"
          : "fragment"
      ] = gl.getShaderSource(s);
    for (
      let i = 0;
      i < gl.getProgramParameter(program, gl.ACTIVE_ATTRIBUTES);
      i++
    ) {
      const a = gl.getActiveAttrib(program, i);
      attributes.push({
        ...a,
        name: a.name,
        type: a.type,
        location: gl.getAttribLocation(program, a.name),
      });
    }
    for (
      let i = 0;
      i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      i++
    ) {
      const u = gl.getActiveUniform(program, i);
      uniforms.push({
        name: u.name.replace(/\[0\]$/, ""),
        type: u.type,
        size: u.size,
        location: gl.getUniformLocation(program, u.name),
      });
    }
    const result = { ...shader, attributes, uniforms };
    programs.set(program, result);
    return result;
  }
  function nativeBlend() {
    const [enabled, rgb, alpha, src, dst, srcA, dstA] =
      context._blendState.fixedValues;
    if (!enabled) return "none";
    if (rgb !== gl.FUNC_ADD || alpha !== gl.FUNC_ADD)
      throw Error("Unsupported raw mesh blend equation");
    const modes = {
      none: [gl.ONE, gl.ZERO],
      normal: [gl.ONE, gl.ONE_MINUS_SRC_ALPHA],
      add: [gl.ONE, gl.ONE],
      multiply: [
        gl.DST_COLOR,
        gl.ONE_MINUS_SRC_ALPHA,
        gl.ONE,
        gl.ONE_MINUS_SRC_ALPHA,
      ],
      screen: [gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA],
      "normal-npm": [
        gl.SRC_ALPHA,
        gl.ONE_MINUS_SRC_ALPHA,
        gl.ONE,
        gl.ONE_MINUS_SRC_ALPHA,
      ],
      erase: [gl.ZERO, gl.ONE_MINUS_SRC_ALPHA],
    };
    for (const [name, [s, d, sa = s, da = d]] of Object.entries(modes)) {
      if (
        src === s &&
        dst === d &&
        (srcA === -1 ? src : srcA) === sa &&
        (dstA === -1 ? dst : dstA) === da
      )
        return name;
    }
    throw Error(
      "Unsupported raw mesh blend factors: " + [src, dst, srcA, dstA],
    );
  }
  function record(mode, first, count, indexType, indexOffset) {
    if (
      !active ||
      (active.entity.renderer !== root &&
        !active.entity.renderer._maskConfig) ||
      (active.entity.renderer === root &&
        active.renderable.assetType === "[renderer CacheRenderer]")
    )
      return;
    if (++recorded % 200 === 0 && !options.quiet)
      console.info("[Pixi] Captured draws", recorded);
    if (mode !== gl.TRIANGLES)
      throw Error("Unsupported primitive mode: " + mode);
    const program = gl.getParameter(gl.CURRENT_PROGRAM),
      meta = metadata(program);
    const bindings = meta.attributes.map((a) => {
      const loc = a.location;
      return {
        name: a.name,
        buffer: gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING),
        size: gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_SIZE),
        type: gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_TYPE),
        enabled: gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_ENABLED),
        stride: gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_STRIDE),
        offset: gl.getVertexAttribOffset(loc, gl.VERTEX_ATTRIB_ARRAY_POINTER),
      };
    });
    const indexBuffer = indexType
      ? gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING)
      : null;
    const geometryKey = options.transport?.geometryKey(
      bindings,
      indexBuffer,
      first,
      count,
      indexType,
      indexOffset,
    );
    let attributes =
      geometryKey && options.transport.geometries.get(geometryKey);
    if (!attributes) {
      const indices = [];
      if (indexType) {
        if (indexType !== gl.UNSIGNED_INT && indexType !== gl.UNSIGNED_SHORT)
          throw Error("Unsupported index type: " + indexType);
        const bytes = bufferBytes(
          gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING),
        );
        const view = new DataView(bytes.buffer);
        const size = indexType === gl.UNSIGNED_INT ? 4 : 2;
        for (let i = 0; i < count; i++)
          indices.push(
            size === 4
              ? view.getUint32(indexOffset + i * size, true)
              : view.getUint16(indexOffset + i * size, true),
          );
      } else for (let i = 0; i < count; i++) indices.push(first + i);
      attributes = {};
      for (const a of meta.attributes) {
        const loc = a.location;
        const type = gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_TYPE),
          size = gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_SIZE);
        if (
          type !== gl.FLOAT ||
          !gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_ENABLED)
        )
          throw Error("Unsupported vertex attribute: " + a.name);
        const bytes = bufferBytes(
          gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_BUFFER_BINDING),
        );
        const stride =
            gl.getVertexAttrib(loc, gl.VERTEX_ATTRIB_ARRAY_STRIDE) || size * 4,
          offset = gl.getVertexAttribOffset(
            loc,
            gl.VERTEX_ATTRIB_ARRAY_POINTER,
          );
        const view = new DataView(bytes.buffer),
          data = new Float32Array(count * size);
        for (let i = 0; i < count; i++)
          for (let j = 0; j < size; j++)
            data[i * size + j] = view.getFloat32(
              offset + indices[i] * stride + j * 4,
              true,
            );
        attributes[a.name] = { data, size };
      }

      if (geometryKey)
        options.transport.geometries.set(geometryKey, attributes);
    }
    const uniforms = {},
      samplers = {};
    for (const u of meta.uniforms) {
      const stored =
        context._currentProgram._program.uniforms[u.name]?.cachedUniform;
      const value = stored
        ? stored.value
        : u.size > 1
          ? Array.from({ length: u.size }, (_, i) => {
              const v = gl.getUniform(
                program,
                gl.getUniformLocation(program, u.name + "[" + i + "]"),
              );
              return ArrayBuffer.isView(v) ? Array.from(v) : v;
            }).flat()
          : gl.getUniform(program, u.location);
      if (u.type === gl.SAMPLER_2D) {
        const t =
          boundTextures.get(value) ||
          context._texContext._samplerStates[value]?.boundedTexture;
        if (!t) throw Error("Unbound sampler " + u.name);
        samplers[u.name] = texturePixels(t);
      } else
        uniforms[u.name] = {
          type: u.type,
          size: u.size,
          value: ArrayBuffer.isView(value) ? Array.from(value) : value,
        };
    }
    const target = active.entity.renderer.view.target;
    const viewport = target
      ? targets.get(target)
      : { x: 0, y: 0, width, height };
    if (!viewport) throw Error("Missing projection bounds for target");
    const entry = {
      kind: "mesh",
      blend: nativeBlend(),
      vertex: meta.vertex,
      fragment: meta.fragment,
      attributes,
      uniforms,
      samplers,
      viewport: { ...viewport },
      offscreen: !!target,
      count,
      bounds: (() => {
        const b = root.getBlendBatchBounds([active]);
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      })(),
    };
    if (!draws.has(active)) draws.set(active, []);
    draws.get(active).push(entry);
  }
  try {
    if (prepareOnly) {
      // Preserve traversal/projection setup. The root is collected for Pixi;
      // supported offscreen source batches and filters render via Pixi too.
      hook(
        base,
        "executeRender",
        (old) =>
          function () {
            const previous = scenePass;
            scenePass = this === root || (!!this._maskConfig && previous);
            try {
              return old.apply(this, arguments);
            } finally {
              scenePass = previous;
            }
          },
      );
      hook(
        root,
        "flushBlendBackdrop",
        (old) =>
          function () {
            // Preserve AwayFL's projection/viewport setup for captured geometry.
            // Only the draws and copy into the accumulator are redundant.
            const previous = backdropPass;
            backdropPass = true;
            try {
              stats.skippedBackdropFlushes++;
              return old.apply(this, arguments);
            } finally {
              backdropPass = previous;
            }
          },
      );
    }
    hook(
      context._texContext,
      "setTextureAt",
      (old) =>
        function (slot, texture) {
          boundTextures.set(slot, texture);
          return old.apply(this, arguments);
        },
    );
    hook(
      base,
      "_initRender",
      (old) =>
        function (target, pad) {
          const b = pad || this._paddedBounds;
          targets.set(target, {
            x: b.x,
            y: b.y,
            width: target.width,
            height: target.height,
          });
          return old.apply(this, arguments);
        },
    );
    hook(
      base,
      "applyTraversable",
      (old) =>
        function (renderable) {
          const item =
            this._renderEntity.abstractions.getAbstraction(renderable);
          if (renderable.assetType === "[renderer CacheRenderer]")
            hookCache(renderable);
          const result = old.apply(this, arguments);
          if (this === root)
            commands.push({
              item,
              cache:
                renderable.assetType === "[renderer CacheRenderer]"
                  ? renderable
                  : null,
              maskNodes: (item.entity.maskOwners || [])
                .map((o) => o.getMasks().slice())
                .filter((a) => a.length),
            });
          if (this._maskConfig) {
            const n = this.node;
            if (!masks.has(n)) masks.set(n, []);
            if (!masks.get(n).includes(item)) masks.get(n).push(item);
          }
          return result;
        },
    );
    // Discover renderable/cache prototypes from the current scene.
    const seen = new Set();
    function hookCache(r) {
      const proto = Object.getPrototypeOf(r);
      if (seen.has(proto)) return;
      seen.add(proto);
      hook(
        proto,
        "render",
        (old) =>
          function () {
            const saved = activeCache;
            activeCache = this;
            try {
              return old.apply(this, arguments);
            } finally {
              activeCache = saved;
            }
          },
      );
      if (!options.transport) r.onInvalidate();
    }
    function walk(n) {
      for (const r of Object.values(n._renderObjects || {}))
        if (r.assetType === "[renderer CacheRenderer]") hookCache(r);
      for (const c of n._children || []) walk(c);
    }
    if (!options.transport) walk(player.root);
    const renderablePrototypes = new Set();
    hook(
      base,
      "drawRenderables",
      (old) =>
        function (items) {
          for (const item of items) {
            const proto = owner(item, "draw");
            if (!renderablePrototypes.has(proto)) {
              renderablePrototypes.add(proto);
              hook(
                proto,
                "draw",
                (fn) =>
                  function () {
                    const saved = active;
                    active = this;
                    draws.set(this, []);
                    try {
                      return fn.apply(this, arguments);
                    } finally {
                      active = saved;
                    }
                  },
              );
            }
          }
          if (
            options.direct &&
            (scenePass || (options.drawSources && this.view.target))
          ) {
            const sourcePass = !scenePass;
            let sourceBatch = [];
            const flushSources = () => {
              if (!sourceBatch.length) return;
              pixiPass = true;
              try {
                options.drawSources(sourceBatch);
              } finally {
                pixiPass = false;
              }
              stats.sourceBatches++;
              sourceBatch = [];
            };
            for (const item of items) {
              // Mask geometry is still collected using the existing traversal.
              // Its meshes take this same direct path when supported.
              if (
                this._activeMasksDirty ||
                this._checkMaskOwners(item.entity.maskOwners)
              ) {
                flushSources();
                this._activeMaskOwners = item.entity.maskOwners;
                if (this._activeMaskOwners)
                  this._renderMasks(this._activeMaskOwners);
                else if (!this._maskConfig) context.disableStencil();
                this._activeMasksDirty = false;
              }
              if (
                this === root &&
                item.renderable.assetType === "[renderer CacheRenderer]"
              ) {
                stats.directCaches++;
                continue;
              }
              const target = this.view.target;
              const viewport = sourcePass
                ? { x: 0, y: 0, width: target.width, height: target.height }
                : target
                  ? targets.get(target)
                  : { x: 0, y: 0, width, height };
              if (!viewport) throw Error("Missing direct projection bounds");
              // Native projection already maps to this framebuffer. Source
              // encoder draws do not need a second bounds/projection calculation.
              const b = sourcePass
                ? viewport
                : root.getBlendBatchBounds([item]);
              const recipe = options.direct.recipe(item, {
                metadata,
                transport: options.transport,
                viewport: { ...viewport },
                offscreen: !!target,
                nativeProjection: sourcePass,
                bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
                fallback: (reason) => {
                  const counts = sourcePass
                    ? stats.sourceFallbacks
                    : stats.directFallbacks;
                  counts[reason] = (counts[reason] || 0) + 1;
                },
              });
              if (recipe) {
                if (sourcePass) {
                  sourceBatch.push({ key: item, recipe });
                  stats.sourceMeshes++;
                  if (this._maskConfig) stats.sourceMaskMeshes++;
                  if (item.renderable.assetType === "[renderer CacheRenderer]")
                    stats.sourceCacheQuads++;
                } else {
                  draws.set(item, [recipe]);
                  stats.directMeshes++;
                }
              } else {
                flushSources();
                old.call(this, [item]);
              }
            }
            flushSources();
            return;
          }
          return old.apply(this, arguments);
        },
    );
    const manager = stage.filterManager;
    if (options.filters)
      hook(
        manager,
        "drawTask",
        (old) =>
          function (task) {
            let handled;
            pixiPass = true;
            try {
              handled = options.filters.draw(task);
            } finally {
              pixiPass = false;
            }
            if (!handled) return old.apply(this, arguments);
            stats.pixiFilterPasses++;
          },
      );
    hook(
      manager,
      "compositePixels",
      (old) =>
        function (source) {
          if (activeCache)
            sources.set(
              activeCache,
              sourcePixels(
                source,
                activeCache,
                source !== activeCache._blendSource,
              ),
            );
          if (prepareOnly && activeCache?.parentRenderer === root) {
            stats.skippedComposites++;
            return true;
          }
          return old.apply(this, arguments);
        },
    );
    hook(
      manager,
      "copyPixels",
      (old) =>
        function (source, target, rect, point, merge, blend) {
          if (
            prepareOnly &&
            backdropPass &&
            target === root._blendAccumulator?.style.image
          )
            return;
          // A top-level non-native cache no longer needs a copied backdrop.
          // Its isolated source and filters use separate temporary images.
          if (
            prepareOnly &&
            activeCache?.parentRenderer === root &&
            activeCache.useNonNativeBlend &&
            !blend &&
            target === activeCache.style.image
          )
            return;
          if (activeCache && blend) {
            sources.set(
              activeCache,
              sourcePixels(
                source,
                activeCache,
                source !== activeCache._blendSource,
              ),
            );
            if (prepareOnly && activeCache.parentRenderer === root) {
              stats.skippedComposites++;
              return;
            }
          }
          return old.apply(this, arguments);
        },
    );
    if (prepareOnly)
      hook(
        gl,
        "clear",
        (old) =>
          function () {
            if (scenePass && !pixiPass) {
              stats.skippedSceneClears++;
              return;
            }
            return old.apply(this, arguments);
          },
      );
    hook(
      gl,
      "bufferData",
      (old) =>
        function () {
          buffers.clear();
          return old.apply(this, arguments);
        },
    );
    hook(
      gl,
      "bufferSubData",
      (old) =>
        function () {
          buffers.clear();
          return old.apply(this, arguments);
        },
    );
    hook(
      gl,
      "drawArrays",
      (old) =>
        function (mode, first, count) {
          if (pixiPass) return old.apply(this, arguments);
          record(mode, first, count);
          if (prepareOnly && scenePass) {
            stats.skippedSceneDraws++;
            return;
          }
          stats.awayDraws++;
          return old.apply(this, arguments);
        },
    );
    hook(
      gl,
      "drawElements",
      (old) =>
        function (mode, count, type, offset) {
          if (pixiPass) return old.apply(this, arguments);
          record(mode, 0, count, type, offset);
          if (prepareOnly && scenePass) {
            stats.skippedSceneDraws++;
            return;
          }
          stats.awayDraws++;
          return old.apply(this, arguments);
        },
    );
    (options.render || (() => root.render()))();
    const reference = options.transport
      ? null
      : new Uint8Array(width * height * 4);
    if (reference)
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, reference);
    const maskMemo = new Map();
    function maskRecipe(node) {
      if (maskMemo.has(node)) return maskMemo.get(node);
      const items = masks.get(node);
      if (!items) throw Error("Uncaptured mask geometry");
      const geometry = items.flatMap((i) => draws.get(i) || []);
      maskMemo.set(node, geometry);
      return geometry;
    }
    const output = commands.map(({ item, cache, maskNodes }) => {
      const entry = {
        key: item,
        masks: maskNodes.map((layer) => layer.flatMap(maskRecipe)),
      };
      if (entry.masks.length) stats.masks++;
      if (cache) {
        const b = cache.getPaddedBounds();
        const flashBlend = cache.node.container.blendMode || "normal";
        // Flash/AwayFL uses "hardlight"; Pixi registers "hard-light".
        const blend = flashBlend === "hardlight" ? "hard-light" : flashBlend;
        const pixels = cache.useNonNativeBlend
          ? sources.get(cache) ||
            options.transport?.sourceFor(cache) ||
            (options.transport && cache._blendSource
              ? sourcePixels(cache._blendSource)
              : null)
          : sourcePixels(cache.style.image);
        if (!pixels) throw Error("Missing isolated blend source");
        if (
          ![
            "normal",
            "layer",
            "add",
            "multiply",
            "screen",
            "overlay",
            "hard-light",
            "lighten",
            "darken",
            "difference",
          ].includes(blend)
        )
          throw Error("Unsupported cache blend: " + blend);
        stats.cachedImages++;
        if (cache.useNonNativeBlend) stats.overlays++;
        return {
          ...entry,
          kind: "cache",
          pixels,
          bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
          blend,
        };
      }
      const geometry = draws.get(item);
      if (!geometry?.length) throw Error("Uncaptured scene geometry");
      stats.meshes += geometry.length;
      stats.triangles += geometry.reduce((s, g) => s + g.count / 3, 0);
      return { ...entry, kind: "geometry", geometry };
    });
    if (gl.isContextLost() || (options.checkErrors !== false && gl.getError()))
      throw Error("Capture generated a WebGL error");
    return {
      width,
      height,
      commands: output,
      reference,
      stats,
      renderer: root,
    };
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}
