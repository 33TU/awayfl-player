// CPU-side recipes for AwayFL's ordinary 2D triangle and stroke materials. This adapter
// never activates a material, binds a vertex buffer or submits an AwayFL draw.
// Other materials continue through capture until their semantics are ported.
export function createDirectScene() {
  const ids = new WeakMap(),
    versions = new WeakMap(),
    geometries = new Map();
  const textures = new WeakMap(),
    hooks = new Map();
  let nextId = 0;
  const id = (o) => {
    if (!ids.has(o)) ids.set(o, ++nextId);
    return ids.get(o);
  };
  function track(buffer) {
    let proto = Object.getPrototypeOf(buffer);
    while (!Object.hasOwn(proto, "invalidate"))
      proto = Object.getPrototypeOf(proto);
    if (!hooks.has(proto)) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, "invalidate");
      hooks.set(proto, descriptor);
      proto.invalidate = function (...args) {
        versions.set(this, (versions.get(this) || 0) + 1);
        return descriptor.value.apply(this, args);
      };
    }
    // Reading the CPU buffer materializes pending layout changes and resets
    // its dirty flag, allowing the next edit to dispatch invalidation again.
    const bytes = buffer.buffer;
    return { bytes, key: id(buffer) + ":" + (versions.get(buffer) || 0) };
  }
  function geometry(elements, shader, meta, count, offset, line) {
    const binding = (view, size = view.dimensions, extra = 0) => ({
      view,
      size,
      extra,
    });
    const views = new Map([
      [
        0,
        binding(
          elements.positions,
          line ? elements.dimension : elements.positions.dimensions,
        ),
      ],
    ]);
    if (shader.uvIndex >= 0)
      views.set(
        shader.uvIndex,
        line
          ? binding(elements.positions, 2)
          : binding(elements.uvs || elements.positions),
      );
    if (shader.curvesIndex >= 0)
      views.set(
        shader.curvesIndex,
        binding(elements.getCustomAtributes("curves")),
      );
    if (line) {
      views.set(
        line.secondaryPositionIndex,
        binding(elements.positions, elements.dimension, elements.dimension * 4),
      );
      views.set(line.thicknessIndex, binding(elements.thickness));
    }
    const attributes = [];
    for (const a of meta.attributes) {
      const index = /^va(\d+)$/.exec(a.name)?.[1];
      const entry = views.get(Number(index));
      if (index === undefined || !entry || entry.view.size !== 4) return null;
      const data = track(entry.view.attributesBuffer);
      attributes.push({ name: a.name, ...entry, data });
    }
    const indices = elements.indices;
    const indexData = indices && track(indices.attributesBuffer);
    const length = indices
      ? count * 3 || indices.count * 3
      : count || elements.numVertices;
    const start = indices ? offset * 3 : offset;
    const key = [
      start,
      length,
      indices
        ? [indexData.key, indices.offset, indices.stride, indices.size].join(
            ":",
          )
        : "",
      ...attributes.map((a) =>
        [
          a.name,
          a.data.key,
          a.view.offset,
          a.view.stride,
          a.size,
          a.extra,
        ].join(":"),
      ),
    ].join("|");
    if (geometries.has(key))
      return { attributes: geometries.get(key), count: length };
    const order = new Uint32Array(length);
    if (indices) {
      if (indices.size !== 2 && indices.size !== 4) return null;
      const source = new DataView(indexData.bytes);
      for (let i = 0; i < length; i++) {
        const at = start + i;
        const byte =
          Math.floor(at / indices.dimensions) *
            indices.attributesBuffer.stride +
          indices.offset +
          (at % indices.dimensions) * indices.size;
        order[i] =
          indices.size === 2
            ? source.getUint16(byte, true)
            : source.getUint32(byte, true);
      }
    } else for (let i = 0; i < length; i++) order[i] = start + i;
    const result = {};
    for (const a of attributes) {
      const source = new DataView(a.data.bytes),
        size = a.size;
      const data = new Float32Array(length * size);
      for (let i = 0; i < length; i++)
        for (let j = 0; j < size; j++)
          data[i * size + j] = source.getFloat32(
            order[i] * a.view.attributesBuffer.stride +
              a.view.offset +
              a.extra +
              j * 4,
            true,
          );
      result[a.name] = { data, size };
    }
    if (geometries.size > 10000) geometries.clear();
    geometries.set(key, result);
    return { attributes: result, count: length };
  }
  function imageTexture(image, sampler, transport) {
    const native = image.getTexture();
    const source = transport.texture(native);
    const scaleMode = sampler
      ? sampler.smooth
        ? "linear"
        : "nearest"
      : source.scaleMode;
    const addressMode = sampler
      ? sampler.repeat
        ? "repeat"
        : "clamp-to-edge"
      : source.addressMode;
    let variants = textures.get(native);
    if (!variants) textures.set(native, (variants = new Map()));
    const key = scaleMode + addressMode;
    let descriptor = variants.get(key);
    if (!descriptor) variants.set(key, (descriptor = {}));
    Object.assign(descriptor, source, { scaleMode, addressMode });
    return descriptor;
  }
  return {
    recipe(
      item,
      { metadata, transport, viewport, offscreen, bounds, fallback },
    ) {
      const reject = (reason) => {
        fallback(reason);
        return null;
      };
      const material = item.renderMaterial;
      const methodMaterial =
        material.material.assetType === "[materials MethodMaterial]";
      if (
        !methodMaterial &&
        material.material.assetType !== "[materials BasicMaterial]"
      )
        return reject("material");
      if (item.entity.node.container.animator) return reject("animator");
      const elements = item.stageElements.elements;
      const isLine = elements.assetType === "[asset LineElements]";
      if (!isLine && elements.assetType !== "[asset TriangleElements]")
        return reject("elements");
      if (material.numPasses !== 1) return reject("multipass");
      const pass = material._passes[0],
        shader = pass.shader;
      const program = shader.programData.program?._program?.program;
      // Cold programs take the compatibility path once. Subsequent frames use
      // the compiled shader description without capturing any draw state.
      if (!program) return reject("cold-program");
      const ambient = methodMaterial ? pass._ambientChunk : null;
      if (
        methodMaterial &&
        (pass._ambientMethod?.assetType !== "[asset AmbientBasicMethod]" ||
          pass._chunks.some((c) => c.chunkVO.useChunk && c !== ambient))
      )
        return reject("method");
      if (
        shader.supportModernAPI ||
        shader.normalIndex >= 0 ||
        shader.tangentIndex >= 0 ||
        shader.jointIndexIndex >= 0 ||
        shader.secondaryUVIndex >= 0 ||
        shader.colorBufferIndex >= 0 ||
        shader.cameraPositionIndex >= 0
      )
        return reject("shader");
      const meta = metadata(program);
      if (
        meta.uniforms.some(
          (u) => !["vc", "fc"].includes(u.name) && !/^fs\d+$/.test(u.name),
        )
      )
        return reject("uniform");
      const line = isLine
        ? item.entity.renderer.getRenderElements(elements)
        : null;
      const mesh = geometry(
        elements,
        shader,
        meta,
        item._count,
        item._offset,
        line,
      );
      if (!mesh) return reject("attributes");
      const mode = material.material.blendMode || "normal";
      const blend =
        mode === "normal"
          ? material.requiresBlending
            ? "normal"
            : "none"
          : mode === "layer"
            ? "normal"
            : mode;
      if (
        !["none", "normal", "add", "multiply", "screen", "erase"].includes(
          blend,
        )
      )
        return reject("blend");
      // ShaderBase's ordinary 2D state update only writes CPU constants. Texture
      // activation is deliberately handled separately, without calling the pass.
      shader._setRenderState(item);
      if (isLine) {
        const view = shader.view;
        const matrix = item.entity.node.getMatrix3D().clone();
        const scale = matrix.decompose()[2],
          half = elements.half_thickness;
        const data = shader.vertexConstantData,
          index = line.uOffsets.oMisc;
        if (elements.scaleMode === 2) {
          data[index] =
            (half * scale.x) / 1000 > 0.5 / (view.focalLength * view.pixelRatio)
              ? scale.x / 1000
              : 0.5 / (half * view.focalLength * view.pixelRatio);
          data[index + 1] =
            (half * scale.y) / 1000 > 0.5 / view.focalLength
              ? scale.y / 1000
              : 0.5 / (half * view.focalLength);
        } else if (elements.scaleMode === 4) {
          data[index] = 1 / (view.focalLength * view.pixelRatio);
          data[index + 1] = 1 / view.focalLength;
        } else
          data[index] = data[index + 1] = 1 / Math.min(view.width, view.height);
        data[index + 2] = view.projection.near;
        shader.viewMatrix.copyFrom(view.frustumMatrix3D, true);
        matrix.append(view.projection.transform.inverseMatrix3D);
        shader.sceneMatrix.copyFrom(matrix, true);
      } else if (shader.sceneMatrixIndex >= 0) {
        shader.sceneMatrix.copyFrom(item.entity.renderSceneTransform, true);
        shader.viewMatrix.copyFrom(shader.view.viewMatrix3D, true);
      } else {
        const matrix = item.entity.renderSceneTransform.clone();
        matrix.append(shader.view.viewMatrix3D);
        shader.viewMatrix.copyFrom(matrix, true);
      }
      const texture = ambient ? ambient._texture : pass._shaderTexture;
      const colorIndex = ambient
        ? ambient._colorIndex
        : pass._fragmentConstantsIndex;
      if (texture) {
        if (shader.useImageRect) {
          const rect = item.samplers[texture._imageIndex]?.imageRect;
          shader.fragmentConstantData.set(
            rect ? [rect.width, rect.height, rect.x, rect.y] : [1, 1, 0, 0],
            texture._samplerIndex,
          );
        }
        if (shader.alphaThreshold > 0)
          shader.fragmentConstantData[colorIndex] = shader.alphaThreshold;
      } else if (ambient) {
        const color = material.material.style.color,
          strength = ambient._method.strength;
        shader.fragmentConstantData.set(
          [
            (((color >> 16) & 255) / 255) * strength,
            (((color >> 8) & 255) / 255) * strength,
            ((color & 255) / 255) * strength,
            ambient._method.alpha,
          ],
          colorIndex,
        );
      } else
        shader.fragmentConstantData.set(
          [pass._diffuseR, pass._diffuseG, pass._diffuseB, pass._diffuseA],
          colorIndex,
        );
      const uniforms = {},
        samplers = {};
      for (const u of meta.uniforms) {
        if (u.name === "vc" || u.name === "fc") {
          const data =
            u.name === "vc"
              ? shader.vertexConstantData
              : shader.fragmentConstantData;
          uniforms[u.name] = {
            type: u.type,
            size: u.size,
            value: Array.from(data.subarray(0, u.size * 4)),
          };
        } else {
          const slot = Number(u.name.slice(2));
          const imageIndex = shader.imageIndices[slot];
          if (!item.images[imageIndex]) return reject("image");
          samplers[u.name] = imageTexture(
            item.images[imageIndex],
            item.samplers[imageIndex],
            transport,
          );
        }
      }
      return {
        kind: "mesh",
        ...mesh,
        blend,
        vertex: meta.vertex,
        fragment: meta.fragment,
        uniforms,
        samplers,
        viewport,
        offscreen,
        bounds,
      };
    },
    destroy() {
      for (const [proto, descriptor] of hooks)
        Object.defineProperty(proto, "invalidate", descriptor);
      hooks.clear();
      geometries.clear();
    },
  };
}
