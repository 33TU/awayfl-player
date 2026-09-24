import { BlurFilter, ColorMatrixFilter } from "pixi.js";
import { GlowFilter } from "pixi-filters/glow";
import { OutlineFilter } from "pixi-filters/outline";
import { DropShadowFilter } from "pixi-filters/drop-shadow";
import { BevelFilter } from "pixi-filters/bevel";

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const quarter = (v) => Math.round(v * 4) / 4;

// Visual equivalents, intentionally not Flash shader emulation. Descriptors are
// also cache keys: stable effects retain their filter objects across frames.
export function describeFilter(f, sx = 1, sy = 1) {
  const blurX = Math.max(0, f.blurX ?? 4);
  const blurY = Math.max(0, f.blurY ?? 4);
  const radius = Math.max(blurX * sx, blurY * sy) / 2;
  const quality = clamp(f.quality || 1, 1, 2);
  const strength = clamp(f.strength ?? 1, 0, 16);
  const color = f.color ?? 0;
  const alpha = clamp(f.alpha ?? 1, 0, 1);
  switch (f.filterName) {
    case "glow":
      // AQW uses narrow, high-strength glows for text borders. A native outline
      // avoids a blur/composite chain and keeps these borders crisp.
      if (!f.inner && strength >= 8 && Math.max(blurX, blurY) <= 6)
        return {
          kind: "outline",
          options: {
            thickness: Math.max(0.5, quarter(radius)),
            color,
            alpha,
            quality: 0.1,
            knockout: !!f.knockout,
          },
        };
      return {
        kind: "glow",
        options: {
          // Glow's WebGL loop radius is compiled into its shader. Recreate when
          // the integer radius changes; assigning distance alone cannot resize it.
          distance: clamp(Math.ceil(radius), 1, 32),
          quality: 0.1,
          color,
          alpha,
          outerStrength: f.inner ? 0 : strength,
          innerStrength: f.inner ? strength : 0,
          knockout: !!f.knockout,
        },
      };
    case "dropShadow": {
      // A strong, narrow zero-offset shadow is a text border. Kawase's sparse
      // diagonal taps become visible as shifted glyph copies when scaled up.
      if (
        !f.inner &&
        !f.hideObject &&
        !f.knockout &&
        (f.distance ?? 4) === 0 &&
        strength >= 4 &&
        Math.max(blurX, blurY) <= 6
      )
        return {
          kind: "outline",
          options: {
            thickness: Math.max(0.5, quarter(radius)),
            color,
            alpha,
            quality: 0.1,
            knockout: false,
          },
        };
      // Pixi has no directional inner shadow. Use an inner glow approximation.
      if (f.inner)
        return describeFilter(
          {
            ...f,
            filterName: "glow",
            blurX,
            blurY,
            color,
            alpha,
            strength,
            inner: true,
            knockout: !!f.knockout,
          },
          sx,
          sy,
        );
      const angle = ((f.angle ?? 45) * Math.PI) / 180;
      return {
        kind: "shadow",
        options: {
          offset: {
            x: quarter(Math.cos(angle) * (f.distance ?? 4) * sx),
            y: quarter(Math.sin(angle) * (f.distance ?? 4) * sy),
          },
          color,
          alpha: clamp(alpha * strength, 0, 1),
          blur: quarter(radius),
          quality,
          shadowOnly: !!(f.hideObject || f.knockout),
        },
      };
    }
    case "blur": {
      // Pixi strength is the distance between Gaussian samples, not a blur
      // radius. Large spacing produces separate copies of thin source shapes.
      // Use nine adjacent samples on a smaller target for broad blurs. Linear
      // upsampling keeps the result smooth without adding full-size passes.
      const width = Math.max(blurX * sx, blurY * sy);
      const resolution = Math.min(
        1,
        2 ** Math.floor(Math.log2(8 / Math.max(8, width))),
      );
      return {
        kind: "blur",
        options: {
          strengthX: (blurX * sx) / 8,
          strengthY: (blurY * sy) / 8,
          resolution,
          kernelSize: 9,
          quality,
        },
        // Padding is in scene pixels, even when the filter target is smaller.
        padding: Math.ceil(width * 0.75),
      };
    }
    case "bevel":
      return {
        kind: "bevel",
        options: {
          rotation: f.angle ?? 45,
          thickness: quarter(Math.abs(f.distance ?? 4) * Math.max(sx, sy)),
          lightColor: f.highlightColor ?? 0xffffff,
          lightAlpha: clamp((f.highlightAlpha ?? 1) * strength, 0, 1),
          shadowColor: f.shadowColor ?? 0,
          shadowAlpha: clamp((f.shadowAlpha ?? 1) * strength, 0, 1),
        },
      };
    case "colorMatrix": {
      const source = f.matrix?.value ?? f.matrix;
      if (!source || source.length !== 20) return null;
      // Flash's additive offsets are byte values; Pixi expects normalized RGBA.
      return {
        kind: "colorMatrix",
        matrix: Array.from(source, (v, i) => (i % 5 === 4 ? v / 255 : v)),
      };
    }
    default:
      return null;
  }
}

export function createFilter(d) {
  switch (d.kind) {
    case "outline":
      return new OutlineFilter(d.options);
    case "glow":
      return new GlowFilter(d.options);
    case "shadow":
      return new DropShadowFilter(d.options);
    case "bevel":
      return new BevelFilter(d.options);
    case "blur": {
      const filter = new BlurFilter(d.options);
      filter.padding = d.padding;
      return filter;
    }
    case "colorMatrix": {
      const filter = new ColorMatrixFilter();
      filter.matrix = d.matrix;
      return filter;
    }
  }
}

export function destroyFilter(filter) {
  // These composite filters do not currently destroy their child filters.
  // pixi-filters is pinned so its owned passes can be released here as well.
  if (filter instanceof DropShadowFilter) {
    filter._blurFilter.destroy();
    filter._basePass.destroy();
  } else if (filter instanceof BlurFilter) {
    filter.blurXFilter.destroy();
    filter.blurYFilter.destroy();
  }
  filter.destroy();
}
