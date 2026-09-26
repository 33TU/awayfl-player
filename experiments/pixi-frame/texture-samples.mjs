// A collapsed UV matrix samples one exact texel. Native solid-color palettes
// append colors to shared images; unrelated writes must not dirty every fill.
// Other UVs (including gradients and fractional/bilinear samples) stay on the
// ordinary whole-image dependency path. No GPU readback or pixel hashing.
export function constantTextureOffset(image, uv, radial = false) {
  if (!image || radial || !uv || uv.a !== 0 || uv.b !== 0 || uv.c !== 0 || uv.d !== 0)
    return null;
  const x = uv.tx * image.width - 0.5, y = uv.ty * image.height - 0.5;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 ||
      x >= image.width || y >= image.height) return null;
  return (y * image.width + x) * 4;
}

function stamp(image, offset) {
  const d = image._data;
  return [image.width, image.height, image.unpackPMA, !!image._imageDataDirty,
    !!image.isDisposed, image._initalFillColor, image._lazySymbol,
    image._alphaChannel?.[offset / 4],
    d?.[offset], d?.[offset + 1], d?.[offset + 2], d?.[offset + 3]];
}
const same = (a, b) => a.every((v, i) => v === b[i]);

export function createTextureSamples(tracker) {
  const images = new Map(), pending = new Set();
  function refresh(image, sample) {
    const next = stamp(image, sample.offset);
    if (same(sample.stamp, next)) return;
    sample.stamp = next;
    for (const listener of sample.listeners) listener.onInvalidate();
  }
  return {
    version(image, offset) {
      let entry = images.get(image);
      if (!entry) {
        entry = { image, samples: new Map() };
        entry.release = tracker.listen(image, () => pending.add(entry));
        images.set(image, entry);
      }
      let sample = entry.samples.get(offset);
      if (!sample) {
        sample = { offset, stamp: stamp(image, offset), listeners: new Set(),
          addAbstraction(r) { this.listeners.add(r); },
          removeAbstraction(r) { this.listeners.delete(r); } };
        entry.samples.set(offset, sample);
      } else refresh(image, sample);
      return tracker.version(sample);
    },
    flush() {
      // Hundreds of palette writes in a tick collapse to one check per used
      // texel. Keep pending work generated during synchronization for next tick.
      const work = [...pending]; pending.clear();
      for (const entry of work)
        for (const sample of entry.samples.values()) refresh(entry.image, sample);
    },
    sweep() {
      for (const [image, entry] of images) {
        for (const [offset, sample] of entry.samples)
          if (!tracker.retained(sample)) entry.samples.delete(offset);
        if (!entry.samples.size) {
          entry.release(); pending.delete(entry); images.delete(image);
        }
      }
    },
    // Textures stay alive while retained fills refer to samples of that image.
    retained(image) { return images.has(image); },
    destroy() {
      for (const entry of images.values()) entry.release();
      images.clear(); pending.clear();
    },
  };
}
