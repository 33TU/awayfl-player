// Preserve the state AwayFL caches internally while Pixi uses the same context.
// This copies state, not framebuffer pixels. Neither renderer owns the other's resources.
export function mirrorGL(gl, context) {
  // Track setters rather than asking the GPU for hundreds of bindings each tick.
  // Unknown states/VAOs are queried once. Hooks are scoped to this context.
  const restore = [],
    values = new Map(),
    enabled = new Map(),
    units = new Map(),
    vaos = new Map();
  const get = gl.getParameter.bind(gl),
    getAttrib = gl.getVertexAttrib.bind(gl),
    getOffset = gl.getVertexAttribOffset.bind(gl);
  let active = get(gl.ACTIVE_TEXTURE),
    vao = get(gl.VERTEX_ARRAY_BINDING);
  const cachedNames = [
    "CURRENT_PROGRAM",
    "ARRAY_BUFFER_BINDING",
    "RENDERBUFFER_BINDING",
    "READ_FRAMEBUFFER_BINDING",
    "DRAW_FRAMEBUFFER_BINDING",
    "VIEWPORT",
    "SCISSOR_BOX",
    "BLEND_SRC_RGB",
    "BLEND_DST_RGB",
    "BLEND_SRC_ALPHA",
    "BLEND_DST_ALPHA",
    "BLEND_EQUATION_RGB",
    "BLEND_EQUATION_ALPHA",
    "BLEND_COLOR",
    "COLOR_WRITEMASK",
    "DEPTH_WRITEMASK",
    "DEPTH_FUNC",
    "DEPTH_RANGE",
    "FRONT_FACE",
    "CULL_FACE_MODE",
    "COLOR_CLEAR_VALUE",
    "DEPTH_CLEAR_VALUE",
    "STENCIL_CLEAR_VALUE",
    "STENCIL_FUNC",
    "STENCIL_REF",
    "STENCIL_VALUE_MASK",
    "STENCIL_WRITEMASK",
    "STENCIL_FAIL",
    "STENCIL_PASS_DEPTH_FAIL",
    "STENCIL_PASS_DEPTH_PASS",
    "STENCIL_BACK_FUNC",
    "STENCIL_BACK_REF",
    "STENCIL_BACK_VALUE_MASK",
    "STENCIL_BACK_WRITEMASK",
    "STENCIL_BACK_FAIL",
    "STENCIL_BACK_PASS_DEPTH_FAIL",
    "STENCIL_BACK_PASS_DEPTH_PASS",
    "UNPACK_ALIGNMENT",
    "PACK_ALIGNMENT",
    "UNPACK_FLIP_Y_WEBGL",
    "UNPACK_PREMULTIPLY_ALPHA_WEBGL",
    "UNPACK_COLORSPACE_CONVERSION_WEBGL",
    "UNPACK_ROW_LENGTH",
    "UNPACK_IMAGE_HEIGHT",
    "UNPACK_SKIP_PIXELS",
    "UNPACK_SKIP_ROWS",
    "UNPACK_SKIP_IMAGES",
    "MAX_COMBINED_TEXTURE_IMAGE_UNITS",
    "MAX_TEXTURE_IMAGE_UNITS",
  ];
  cachedNames.forEach((n) => values.set(gl[n], get(gl[n])));
  function hook(name, fn) {
    const old = gl[name];
    gl[name] = fn(old);
    restore.push(() => (gl[name] = old));
  }
  function unit() {
    if (!units.has(active)) units.set(active, new Map());
    return units.get(active);
  }
  function vertex() {
    if (!vaos.has(vao)) vaos.set(vao, { attributes: new Map() });
    return vaos.get(vao);
  }
  function attribute(i) {
    const v = vertex();
    if (!v.attributes.has(i)) v.attributes.set(i, new Map());
    return v.attributes.get(i);
  }
  const set = (n, v) => values.set(gl[n], v);
  hook(
    "getParameter",
    () =>
      function (p) {
        if (p === gl.ACTIVE_TEXTURE) return active;
        if (p === gl.VERTEX_ARRAY_BINDING) return vao;
        if (
          [
            gl.TEXTURE_BINDING_2D,
            gl.TEXTURE_BINDING_CUBE_MAP,
            gl.SAMPLER_BINDING,
          ].includes(p)
        ) {
          const u = unit();
          if (!u.has(p)) u.set(p, get(p));
          return u.get(p);
        }
        if (p === gl.ELEMENT_ARRAY_BUFFER_BINDING) {
          const v = vertex();
          if (!("index" in v)) v.index = get(p);
          return v.index;
        }
        return values.has(p) ? values.get(p) : get(p);
      },
  );
  hook(
    "isEnabled",
    (old) =>
      function (p) {
        if (!enabled.has(p)) enabled.set(p, old.call(this, p));
        return enabled.get(p);
      },
  );
  for (const [name, on] of [
    ["enable", true],
    ["disable", false],
  ])
    hook(
      name,
      (old) =>
        function (p) {
          enabled.set(p, on);
          return old.apply(this, arguments);
        },
    );
  hook(
    "activeTexture",
    (old) =>
      function (v) {
        active = v;
        return old.apply(this, arguments);
      },
  );
  hook(
    "bindTexture",
    (old) =>
      function (target, t) {
        if (target === gl.TEXTURE_2D) unit().set(gl.TEXTURE_BINDING_2D, t);
        if (target === gl.TEXTURE_CUBE_MAP)
          unit().set(gl.TEXTURE_BINDING_CUBE_MAP, t);
        return old.apply(this, arguments);
      },
  );
  hook(
    "bindSampler",
    (old) =>
      function (i, s) {
        const k = gl.TEXTURE0 + i;
        if (!units.has(k)) units.set(k, new Map());
        units.get(k).set(gl.SAMPLER_BINDING, s);
        return old.apply(this, arguments);
      },
  );
  hook(
    "bindVertexArray",
    (old) =>
      function (v) {
        vao = v;
        return old.apply(this, arguments);
      },
  );
  hook(
    "bindBuffer",
    (old) =>
      function (target, b) {
        if (target === gl.ARRAY_BUFFER) set("ARRAY_BUFFER_BINDING", b);
        if (target === gl.ELEMENT_ARRAY_BUFFER) vertex().index = b;
        return old.apply(this, arguments);
      },
  );
  hook(
    "bindFramebuffer",
    (old) =>
      function (target, f) {
        if (target !== gl.DRAW_FRAMEBUFFER) set("READ_FRAMEBUFFER_BINDING", f);
        if (target !== gl.READ_FRAMEBUFFER) set("DRAW_FRAMEBUFFER_BINDING", f);
        return old.apply(this, arguments);
      },
  );
  hook(
    "pixelStorei",
    (old) =>
      function (p, v) {
        if (values.has(p)) values.set(p, v);
        return old.apply(this, arguments);
      },
  );
  for (const [name, fields] of Object.entries({
    useProgram: ["CURRENT_PROGRAM"],
    bindRenderbuffer: ["RENDERBUFFER_BINDING"],
    depthMask: ["DEPTH_WRITEMASK"],
    depthFunc: ["DEPTH_FUNC"],
    frontFace: ["FRONT_FACE"],
    cullFace: ["CULL_FACE_MODE"],
    clearDepth: ["DEPTH_CLEAR_VALUE"],
    clearStencil: ["STENCIL_CLEAR_VALUE"],
  }))
    hook(
      name,
      (old) =>
        function (...args) {
          set(fields[0], args.at(-1));
          return old.apply(this, args);
        },
    );
  for (const [name, field] of Object.entries({
    viewport: "VIEWPORT",
    scissor: "SCISSOR_BOX",
    blendColor: "BLEND_COLOR",
    colorMask: "COLOR_WRITEMASK",
    depthRange: "DEPTH_RANGE",
    clearColor: "COLOR_CLEAR_VALUE",
  }))
    hook(
      name,
      (old) =>
        function (...args) {
          set(field, args);
          return old.apply(this, args);
        },
    );
  hook(
    "blendFuncSeparate",
    (old) =>
      function (s, d, sa, da) {
        set("BLEND_SRC_RGB", s);
        set("BLEND_DST_RGB", d);
        set("BLEND_SRC_ALPHA", sa);
        set("BLEND_DST_ALPHA", da);
        return old.apply(this, arguments);
      },
  );
  hook(
    "blendFunc",
    (old) =>
      function (s, d) {
        set("BLEND_SRC_RGB", s);
        set("BLEND_DST_RGB", d);
        set("BLEND_SRC_ALPHA", s);
        set("BLEND_DST_ALPHA", d);
        return old.apply(this, arguments);
      },
  );
  hook(
    "blendEquationSeparate",
    (old) =>
      function (r, a) {
        set("BLEND_EQUATION_RGB", r);
        set("BLEND_EQUATION_ALPHA", a);
        return old.apply(this, arguments);
      },
  );
  hook(
    "blendEquation",
    (old) =>
      function (v) {
        set("BLEND_EQUATION_RGB", v);
        set("BLEND_EQUATION_ALPHA", v);
        return old.apply(this, arguments);
      },
  );
  for (const [name, fields] of Object.entries({
    stencilFunc: ["FUNC", "REF", "VALUE_MASK"],
    stencilOp: ["FAIL", "PASS_DEPTH_FAIL", "PASS_DEPTH_PASS"],
    stencilMask: ["WRITEMASK"],
  })) {
    const write = (face, args) => {
      for (const [f, p] of [
        [gl.FRONT, "STENCIL_"],
        [gl.BACK, "STENCIL_BACK_"],
      ])
        if (face === f || face === gl.FRONT_AND_BACK)
          fields.forEach((k, i) => set(p + k, args[i]));
    };
    hook(
      name,
      (old) =>
        function (...args) {
          write(gl.FRONT_AND_BACK, args);
          return old.apply(this, args);
        },
    );
    hook(
      name + "Separate",
      (old) =>
        function (face, ...args) {
          write(face, args);
          return old.call(this, face, ...args);
        },
    );
  }
  hook(
    "vertexAttribPointer",
    (old) =>
      function (i, size, type, normalized, stride, offset) {
        const a = attribute(i);
        for (const [n, v] of [
          [
            "VERTEX_ATTRIB_ARRAY_BUFFER_BINDING",
            values.get(gl.ARRAY_BUFFER_BINDING),
          ],
          ["VERTEX_ATTRIB_ARRAY_SIZE", size],
          ["VERTEX_ATTRIB_ARRAY_TYPE", type],
          ["VERTEX_ATTRIB_ARRAY_NORMALIZED", normalized],
          ["VERTEX_ATTRIB_ARRAY_STRIDE", stride],
          ["VERTEX_ATTRIB_ARRAY_POINTER", offset],
        ])
          a.set(gl[n], v);
        return old.apply(this, arguments);
      },
  );
  for (const [name, on] of [
    ["enableVertexAttribArray", true],
    ["disableVertexAttribArray", false],
  ])
    hook(
      name,
      (old) =>
        function (i) {
          attribute(i).set(gl.VERTEX_ATTRIB_ARRAY_ENABLED, on);
          return old.apply(this, arguments);
        },
    );
  hook(
    "getVertexAttrib",
    () =>
      function (i, p) {
        const a = attribute(i);
        if (!a.has(p)) a.set(p, getAttrib(i, p));
        return a.get(p);
      },
  );
  hook(
    "getVertexAttribOffset",
    () =>
      function (i, p) {
        const a = attribute(i);
        if (!a.has(p)) a.set(p, getOffset(i, p));
        return a.get(p);
      },
  );
  hook(
    "deleteVertexArray",
    (old) =>
      function (v) {
        vaos.delete(v);
        if (vao === v) vao = null;
        return old.apply(this, arguments);
      },
  );
  hook(
    "deleteTexture",
    (old) =>
      function (t) {
        for (const u of units.values())
          for (const [k, v] of u) if (v === t) u.set(k, null);
        return old.apply(this, arguments);
      },
  );
  hook(
    "deleteBuffer",
    (old) =>
      function (b) {
        if (values.get(gl.ARRAY_BUFFER_BINDING) === b)
          set("ARRAY_BUFFER_BINDING", null);
        for (const v of vaos.values()) if (v.index === b) v.index = null;
        return old.apply(this, arguments);
      },
  );
  if (context?._vaoContext) {
    const v = context._vaoContext,
      bind = v._bindVertexArray,
      del = v._deleteVertexArray;
    v._bindVertexArray = (array) => gl.bindVertexArray(array);
    v._deleteVertexArray = (array) => gl.deleteVertexArray(array);
    restore.push(() => {
      v._bindVertexArray = bind;
      v._deleteVertexArray = del;
    });
  }
  return () => {
    for (const fn of restore.reverse()) fn();
  };
}

export function saveGL(gl) {
  const get = (name) => gl.getParameter(gl[name]);
  const names = [
    "CURRENT_PROGRAM",
    "VERTEX_ARRAY_BINDING",
    "ARRAY_BUFFER_BINDING",
    "ELEMENT_ARRAY_BUFFER_BINDING",
    "RENDERBUFFER_BINDING",
    "READ_FRAMEBUFFER_BINDING",
    "DRAW_FRAMEBUFFER_BINDING",
    "ACTIVE_TEXTURE",
    "VIEWPORT",
    "SCISSOR_BOX",
    "BLEND_SRC_RGB",
    "BLEND_DST_RGB",
    "BLEND_SRC_ALPHA",
    "BLEND_DST_ALPHA",
    "BLEND_EQUATION_RGB",
    "BLEND_EQUATION_ALPHA",
    "BLEND_COLOR",
    "COLOR_WRITEMASK",
    "DEPTH_WRITEMASK",
    "DEPTH_FUNC",
    "DEPTH_RANGE",
    "FRONT_FACE",
    "CULL_FACE_MODE",
    "COLOR_CLEAR_VALUE",
    "DEPTH_CLEAR_VALUE",
    "STENCIL_CLEAR_VALUE",
    "STENCIL_FUNC",
    "STENCIL_REF",
    "STENCIL_VALUE_MASK",
    "STENCIL_WRITEMASK",
    "STENCIL_FAIL",
    "STENCIL_PASS_DEPTH_FAIL",
    "STENCIL_PASS_DEPTH_PASS",
    "STENCIL_BACK_FUNC",
    "STENCIL_BACK_REF",
    "STENCIL_BACK_VALUE_MASK",
    "STENCIL_BACK_WRITEMASK",
    "STENCIL_BACK_FAIL",
    "STENCIL_BACK_PASS_DEPTH_FAIL",
    "STENCIL_BACK_PASS_DEPTH_PASS",
  ];
  const s = Object.fromEntries(names.map((n) => [n, get(n)]));
  const flags = [
    "BLEND",
    "CULL_FACE",
    "DEPTH_TEST",
    "STENCIL_TEST",
    "SCISSOR_TEST",
    "POLYGON_OFFSET_FILL",
  ];
  const enabled = flags.map((n) => gl.isEnabled(gl[n]));
  const stores = [
    "UNPACK_ALIGNMENT",
    "PACK_ALIGNMENT",
    "UNPACK_FLIP_Y_WEBGL",
    "UNPACK_PREMULTIPLY_ALPHA_WEBGL",
    "UNPACK_COLORSPACE_CONVERSION_WEBGL",
    "UNPACK_ROW_LENGTH",
    "UNPACK_IMAGE_HEIGHT",
    "UNPACK_SKIP_PIXELS",
    "UNPACK_SKIP_ROWS",
    "UNPACK_SKIP_IMAGES",
  ];
  const pixels = stores.map(get),
    textures = [];
  for (let i = 0; i < get("MAX_TEXTURE_IMAGE_UNITS"); i++) {
    gl.activeTexture(gl.TEXTURE0 + i);
    textures.push([
      get("TEXTURE_BINDING_2D"),
      get("TEXTURE_BINDING_CUBE_MAP"),
      get("SAMPLER_BINDING"),
    ]);
  }
  gl.activeTexture(s.ACTIVE_TEXTURE);
  return () => {
    gl.useProgram(s.CURRENT_PROGRAM);
    gl.bindVertexArray(s.VERTEX_ARRAY_BINDING);
    gl.bindBuffer(gl.ARRAY_BUFFER, s.ARRAY_BUFFER_BINDING);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, s.ELEMENT_ARRAY_BUFFER_BINDING);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.READ_FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, s.DRAW_FRAMEBUFFER_BINDING);
    gl.bindRenderbuffer(gl.RENDERBUFFER, s.RENDERBUFFER_BINDING);
    gl.viewport(...s.VIEWPORT);
    gl.scissor(...s.SCISSOR_BOX);
    gl.blendFuncSeparate(
      s.BLEND_SRC_RGB,
      s.BLEND_DST_RGB,
      s.BLEND_SRC_ALPHA,
      s.BLEND_DST_ALPHA,
    );
    gl.blendEquationSeparate(s.BLEND_EQUATION_RGB, s.BLEND_EQUATION_ALPHA);
    gl.blendColor(...s.BLEND_COLOR);
    gl.colorMask(...s.COLOR_WRITEMASK);
    gl.depthMask(s.DEPTH_WRITEMASK);
    gl.depthFunc(s.DEPTH_FUNC);
    gl.depthRange(...s.DEPTH_RANGE);
    gl.frontFace(s.FRONT_FACE);
    gl.cullFace(s.CULL_FACE_MODE);
    gl.clearColor(...s.COLOR_CLEAR_VALUE);
    gl.clearDepth(s.DEPTH_CLEAR_VALUE);
    gl.clearStencil(s.STENCIL_CLEAR_VALUE);
    for (const [face, prefix] of [
      [gl.FRONT, "STENCIL_"],
      [gl.BACK, "STENCIL_BACK_"],
    ]) {
      gl.stencilFuncSeparate(
        face,
        s[prefix + "FUNC"],
        s[prefix + "REF"],
        s[prefix + "VALUE_MASK"],
      );
      gl.stencilMaskSeparate(face, s[prefix + "WRITEMASK"]);
      gl.stencilOpSeparate(
        face,
        s[prefix + "FAIL"],
        s[prefix + "PASS_DEPTH_FAIL"],
        s[prefix + "PASS_DEPTH_PASS"],
      );
    }
    flags.forEach((n, i) => gl[enabled[i] ? "enable" : "disable"](gl[n]));
    stores.forEach((n, i) => gl.pixelStorei(gl[n], pixels[i]));
    textures.forEach(([t, c, sampler], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, c);
      gl.bindSampler(i, sampler);
    });
    gl.activeTexture(s.ACTIVE_TEXTURE);
  };
}

export function createTransport(gl) {
  const buffers = new WeakMap(),
    ids = new WeakMap(),
    textures = new WeakMap(),
    copies = new Map();
  const geometries = new Map();
  let id = 0,
    epoch = 0,
    tracking = true;
  const stats = {
    initialBufferReads: 0,
    bufferUploads: 0,
    textureCopies: 0,
    pixelReadbacks: 0,
  };
  function identity(o) {
    if (!o) return 0;
    if (!ids.has(o)) ids.set(o, ++id);
    return ids.get(o);
  }
  function bound(target) {
    return gl.getParameter(
      target === gl.ELEMENT_ARRAY_BUFFER
        ? gl.ELEMENT_ARRAY_BUFFER_BINDING
        : gl.ARRAY_BUFFER_BINDING,
    );
  }
  const originalData = gl.bufferData,
    originalSub = gl.bufferSubData,
    originalDelete = gl.deleteTexture,
    originalRead = gl.readPixels;
  gl.readPixels = function () {
    stats.pixelReadbacks++;
    return originalRead.apply(this, arguments);
  };
  gl.deleteTexture = function (handle) {
    const entry = textures.get(handle);
    if (tracking && entry?.epoch === epoch) {
      const copy = texture(
        {
          _glTexture: handle,
          width: entry.width,
          height: entry.height,
          _state: {
            filter: entry.scaleMode === "linear" ? gl.LINEAR : gl.NEAREST,
          },
        },
        entry,
      );
      entry.handle = copy.handle;
    }
    return originalDelete.apply(this, arguments);
  };
  function bytes(data, offset = 0, length) {
    if (typeof data === "number") return new Uint8Array(data);
    const size = data.BYTES_PER_ELEMENT || 1;
    return new Uint8Array(
      data.buffer || data,
      (data.byteOffset || 0) + offset * size,
      length === undefined ? data.byteLength - offset * size : length * size,
    );
  }
  gl.bufferData = function (target, data, usage, offset, length) {
    const result = originalData.apply(this, arguments);
    if (
      tracking &&
      (target === gl.ARRAY_BUFFER || target === gl.ELEMENT_ARRAY_BUFFER)
    ) {
      const buffer = bound(target),
        old = buffers.get(buffer);
      buffers.set(buffer, {
        data: bytes(data, offset, length).slice(),
        version: (old?.version || 0) + 1,
      });
      stats.bufferUploads++;
    }
    return result;
  };
  gl.bufferSubData = function (target, offset, data, srcOffset, length) {
    const result = originalSub.apply(this, arguments);
    if (
      tracking &&
      (target === gl.ARRAY_BUFFER || target === gl.ELEMENT_ARRAY_BUFFER)
    ) {
      const buffer = bound(target),
        old = buffers.get(buffer);
      if (old) {
        old.data.set(bytes(data, srcOffset, length), offset);
        old.version++;
      }
      stats.bufferUploads++;
    }
    return result;
  };
  function bufferBytes(buffer) {
    let record = buffers.get(buffer);
    if (record) return record.data;
    const prev = gl.getParameter(gl.COPY_READ_BUFFER_BINDING);
    try {
      gl.bindBuffer(gl.COPY_READ_BUFFER, buffer);
      const data = new Uint8Array(
        gl.getBufferParameter(gl.COPY_READ_BUFFER, gl.BUFFER_SIZE),
      );
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, data);
      buffers.set(buffer, (record = { data, version: 0 }));
      stats.initialBufferReads++;
      return data;
    } finally {
      gl.bindBuffer(gl.COPY_READ_BUFFER, prev);
    }
  }
  function texture(t, key) {
    const width = t.width ?? t._width,
      height = t.height ?? t._height;
    const style = {
      scaleMode: t._state?.filter === gl.LINEAR ? "linear" : "nearest",
      addressMode: t._state?.wrap === gl.REPEAT ? "repeat" : "clamp-to-edge",
    };
    if (!key) {
      let entry = textures.get(t._glTexture);
      if (!entry) {
        entry = { handle: t._glTexture, width, height, ...style };
        textures.set(t._glTexture, entry);
      }
      Object.assign(entry, { width, height, ...style, epoch });
      return entry;
    }
    let entry = copies.get(key);
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING),
      draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
      binding = gl.getParameter(gl.TEXTURE_BINDING_2D);
    try {
      if (t._renderTarget?.isMsaaTarget) t._renderTarget.present();
      if (!entry) {
        entry = {
          handle: gl.createTexture(),
          fb: gl.createFramebuffer(),
          width: 0,
          height: 0,
        };
        copies.set(key, entry);
      }
      gl.bindTexture(gl.TEXTURE_2D, entry.handle);
      if (entry.width !== width || entry.height !== height)
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA,
          width,
          height,
          0,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          null,
        );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MIN_FILTER,
        t._state?.filter === gl.LINEAR ? gl.LINEAR : gl.NEAREST,
      );
      gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_MAG_FILTER,
        t._state?.filter === gl.LINEAR ? gl.LINEAR : gl.NEAREST,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, entry.fb);
      gl.framebufferTexture2D(
        gl.READ_FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        t._glTexture,
        0,
      );
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, width, height);
      Object.assign(entry, { width, height, ...style, epoch });
      stats.textureCopies++;
      return entry;
    } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
      gl.bindTexture(gl.TEXTURE_2D, binding);
    }
  }
  return {
    stats,
    geometries,
    bufferBytes,
    texture,
    identity,
    sourceFor(key) {
      const e = copies.get(key);
      if (e) e.epoch = epoch;
      return e;
    },
    begin() {
      epoch++;
      tracking = true;
      if (geometries.size > 10000) geometries.clear();
    },
    suspend() {
      tracking = false;
    },
    resume() {
      tracking = true;
    },
    geometryKey(bindings, index, first, count, type, offset) {
      return [
        identity(index),
        buffers.get(index)?.version || 0,
        first,
        count,
        type,
        offset,
        ...bindings.flatMap((b) => [
          b.name,
          identity(b.buffer),
          buffers.get(b.buffer)?.version || 0,
          b.size,
          b.type,
          b.stride,
          b.offset,
        ]),
      ].join(":");
    },
    sweep() {
      for (const [k, e] of copies)
        if (epoch - e.epoch > 120) {
          gl.deleteTexture(e.handle);
          gl.deleteFramebuffer(e.fb);
          copies.delete(k);
        }
    },
    destroy() {
      gl.bufferData = originalData;
      gl.bufferSubData = originalSub;
      gl.deleteTexture = originalDelete;
      gl.readPixels = originalRead;
      for (const e of copies.values()) {
        gl.deleteTexture(e.handle);
        gl.deleteFramebuffer(e.fb);
      }
      copies.clear();
      geometries.clear();
    },
  };
}
