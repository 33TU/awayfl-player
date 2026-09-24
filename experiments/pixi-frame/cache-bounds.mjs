// CacheRenderer limits its raster scale to 3. Its padded rectangle is in that
// texture coordinate space, not necessarily in backbuffer pixels. Match the
// native cache quad: undo the cache scale, then apply the root view projection.
export function projectCacheBounds(bounds, scale, matrix, width, height) {
  function project(x, y) {
    x /= scale;
    y /= scale;
    const w = matrix[3] * x + matrix[7] * y + matrix[15];
    return {
      x: (((matrix[0] * x + matrix[4] * y + matrix[12]) / w + 1) * width) / 2,
      y: ((1 - (matrix[1] * x + matrix[5] * y + matrix[13]) / w) * height) / 2,
    };
  }
  const start = project(bounds.x, bounds.y);
  const end = project(bounds.x + bounds.width, bounds.y + bounds.height);
  return {
    x: start.x,
    y: start.y,
    width: end.x - start.x,
    height: end.y - start.y,
  };
}
