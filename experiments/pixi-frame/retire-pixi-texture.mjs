import { BindGroup, Texture } from 'pixi.js';

// Pixi's texture batch groups are cached beyond a renderer's lifetime. Replace
// references to an owned texture before releasing it, so those cached groups
// cannot keep a destroyed texture source bound or emit BindGroup warnings.
export function retirePixiTexture(texture) {
  if (!texture || texture.destroyed) return;
  const source = texture.source;
  for (const [resource, replacement] of [
    [source, Texture.EMPTY.source],
    [source.style, Texture.EMPTY.source.style],
  ]) {
    let listener = resource?._events?.change;
    while (listener) {
      const next = listener.next;
      const group = listener.context;
      if (group instanceof BindGroup && group.resources)
        for (const [index, current] of Object.entries(group.resources))
          if (current === resource) group.setResource(replacement, +index);
      listener = next;
    }
  }
  texture.destroy(true);
}
