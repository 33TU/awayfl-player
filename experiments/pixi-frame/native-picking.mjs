// The Flash input dispatcher still owns event order and capture. For shapes
// drawn by Pixi, let its retained path answer the fine hit test and bounds.
function contextBox(context, matrix3D, Box, cache, target) {
  const { minX, minY, maxX, maxY } = context.bounds;
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
  const corners = [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]];
  const matrix = matrix3D?._rawData;
  if (matrix && matrix.length < 16) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const [x, y] of corners) {
    const px = matrix ? x * matrix[0] + y * matrix[4] + matrix[12] : x;
    const py = matrix ? x * matrix[1] + y * matrix[5] + matrix[13] : y;
    const pz = matrix ? x * matrix[2] + y * matrix[6] + matrix[14] : 0;
    x0 = Math.min(x0, px); y0 = Math.min(y0, py); z0 = Math.min(z0, pz);
    x1 = Math.max(x1, px); y1 = Math.max(y1, py); z1 = Math.max(z1, pz);
  }
  if (target) {
    x0 = Math.min(x0, target.x); y0 = Math.min(y0, target.y); z0 = Math.min(z0, target.z);
    x1 = Math.max(x1, target.x + target.width);
    y1 = Math.max(y1, target.y + target.height);
    z1 = Math.max(z1, target.z + target.depth);
  }
  const result = target || cache || new Box();
  result.x = x0; result.y = y0; result.z = z0;
  result.width = x1 - x0; result.height = y1 - y0; result.depth = z1 - z0;
  return result;
}

export function createNativePicking(Box) {
  const owned = new Map();
  function bind(elements, context) {
    if (!elements || typeof elements.hitTestPoint !== 'function' || !context) return false;
    let record = owned.get(elements);
    if (!record) {
      const descriptor = Object.getOwnPropertyDescriptor(elements, 'hitTestPoint');
      const boundsDescriptor = Object.getOwnPropertyDescriptor(elements, 'getBoxBounds');
      if ((descriptor && !descriptor.configurable) ||
          (boundsDescriptor && !boundsDescriptor.configurable)) return false;
      const original = elements.hitTestPoint;
      const originalBounds = elements.getBoxBounds;
      record = { descriptor, boundsDescriptor, original, contexts: new Map() };
      const wrapper = function(node, x, y, z, box, count = 0, offset = 0, ...rest) {
        if (!count && !offset && record.contexts.size === 1 &&
            Number.isFinite(x) && Number.isFinite(y)) {
          const only = record.contexts.keys().next().value;
          if (!only.destroyed) return only.containsPoint({ x, y });
        }
        return original.call(this, node, x, y, z, box, count, offset, ...rest);
      };
      Object.defineProperty(elements, 'hitTestPoint', { configurable: true, value: wrapper });
      if (Box && typeof originalBounds === 'function') {
        Object.defineProperty(elements, 'getBoxBounds', { configurable: true,
          value: function(node, strokeFlag, matrix3D, cache, target, count = 0, offset = 0) {
            if (!count && !offset && record.contexts.size === 1) {
              const only = record.contexts.keys().next().value;
              if (!only.destroyed) {
                const result = contextBox(only, matrix3D, Box, cache, target);
                if (result) return result;
              }
            }
            return originalBounds.call(this, node, strokeFlag, matrix3D,
              cache, target, count, offset);
          } });
      }
      owned.set(elements, record);
    }
    record.contexts.set(context, (record.contexts.get(context) || 0) + 1);
    return true;
  }
  function release(elements, context) {
    const record = owned.get(elements);
    if (!record) return;
    const count = record.contexts.get(context);
    if (!count) return;
    if (count === 1) record.contexts.delete(context);
    else record.contexts.set(context, count - 1);
    if (!record.contexts.size) {
      if (record.descriptor) Object.defineProperty(elements, 'hitTestPoint', record.descriptor);
      else delete elements.hitTestPoint;
      if (Box) {
        if (record.boundsDescriptor) Object.defineProperty(elements, 'getBoxBounds', record.boundsDescriptor);
        else delete elements.getBoxBounds;
      }
      owned.delete(elements);
    }
  }
  return { bind, release, destroy() {
    for (const [elements, record] of owned) {
      if (record.descriptor) Object.defineProperty(elements, 'hitTestPoint', record.descriptor);
      else delete elements.hitTestPoint;
      if (Box) {
        if (record.boundsDescriptor) Object.defineProperty(elements, 'getBoxBounds', record.boundsDescriptor);
        else delete elements.getBoxBounds;
      }
    }
    owned.clear();
  } };
}
