// Ranges are half-open Float32 slots. Merge nearby edits, then bound driver
// calls by bridging the smallest gaps. Dense edits use the original union.
export function planUploadRanges(ranges, gap = 4096, limit = 8) {
  const sorted = ranges.slice().sort((a, b) => a[0] - b[0]);
  let result = [];
  for (const [start, end] of sorted) {
    if (end <= start) continue;
    const last = result.at(-1);
    if (last && start <= last[1] + gap) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  if (result.length > limit) {
    // Preserve the largest gaps, avoiding quadratic repeated merging when
    // many non-adjacent objects change in a single batch.
    const cuts = new Set(result.slice(1).map((r, i) => [i, r[0] - result[i][1]])
      .sort((a, b) => b[1] - a[1]).slice(0, limit - 1).map(r => r[0]));
    const bounded = [];
    let start = result[0][0];
    for (let i = 0; i < result.length; i++) {
      if (cuts.has(i) || i === result.length - 1) {
        bounded.push([start, result[i][1]]);
        start = result[i + 1]?.[0];
      }
    }
    result = bounded;
  }
  if (result.length > 1) {
    const start = result[0][0], end = result.at(-1)[1];
    if (result.reduce((n, r) => n + r[1] - r[0], 0) >= (end - start) * 0.75)
      return [[start, end]];
  }
  return result;
}

// Pixi 8.21 retains only one update span on Buffer. Carry additional spans
// until its normal GL upload, so hidden groups and profiling keep their timing.
// Only our vector vertex buffers are registered; indices/uniforms use Pixi.
export function installRangeUploads(renderer) {
  const system = renderer.buffer, original = system.updateBuffer;
  const pending = new WeakMap();
  function update(buffer) {
    const ticket = pending.get(buffer);
    if (!ticket) return original.call(this, buffer);
    pending.delete(buffer);
    const gpu = buffer._gpuData[renderer.uid];
    if (ticket.revision !== buffer._updateID || ticket.data !== buffer.data ||
        !gpu || gpu !== ticket.gpu || gpu.updateID !== ticket.previousRevision ||
        gpu.byteLength < buffer.data.byteLength)
      return original.call(this, buffer);
    // Retain getGlBuffer's GC usage bookkeeping and normal update revision.
    this.getGlBuffer(buffer);
    const gl = this._gl, data = buffer.data;
    gl.bindBuffer(gpu.type, gpu.buffer);
    for (const [start, end] of ticket.ranges)
      gl.bufferSubData(gpu.type, start * 4, data, start, end - start);
    gpu.updateID = buffer._updateID;
    return gpu;
  }
  system.updateBuffer = update;
  return {
    queue(buffer, ranges) {
      if (ranges.length < 2) return;
      const gpu = buffer._gpuData[renderer.uid];
      pending.set(buffer, { ranges, gpu, previousRevision: gpu.updateID,
        revision: buffer._updateID, data: buffer.data });
    },
    clear(buffer) { if (buffer) pending.delete(buffer); },
    restore() { if (system.updateBuffer === update) system.updateBuffer = original; },
  };
}
