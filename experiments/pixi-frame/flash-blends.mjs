import { BlendModeFilter, ExtensionType, extensions } from "pixi.js";
import "pixi.js/advanced-blend-modes";

// Both input textures are premultiplied. Evaluate the blend function B on
// straight colors, then combine source/backdrop coverage into a premultiplied
// result: s(1 - ab) + d(1 - as) + B·as·ab. This is the compositing equation
// Ruffle's blend shaders use. Pixi's own advanced blends mix against the
// backdrop color regardless of its alpha, so over a transparent backdrop they
// blended against black: overlay layers drawn into a transparent BitmapData
// (World.rasterize, Smooth Background off) vanished, and Yulgar's lamp glows
// were missing from the room.
function flashBlend(name, glBlend, wgslBlend) {
  class FlashBlend extends BlendModeFilter {
    constructor() {
      super({
        gl: {
          functions: "",
          main: `
            // No epsilon divide: filter shaders run at mediump, which AMD
            // GPUs evaluate as fp16, where 0.00001 flushes to zero. Fully
            // transparent texels then computed 0/0 = NaN and composited as
            // opaque black boxes over every blend layer's bounds.
            vec3 s = front.a > 0.0 ? front.rgb / front.a : vec3(0.0);
            vec3 d = back.a > 0.0 ? back.rgb / back.a : vec3(0.0);
            vec3 b = ${glBlend};
            finalColor = vec4(front.rgb * (1.0 - back.a)
              + back.rgb * (1.0 - front.a) + b * front.a * back.a,
              blendedAlpha) * uBlend;
          `,
        },
        gpu: {
          functions: "",
          main: `
            let s = select(vec3<f32>(0.0), front.rgb / front.a, front.a > 0.0);
            let d = select(vec3<f32>(0.0), back.rgb / back.a, back.a > 0.0);
            let b = ${wgslBlend};
            out = vec4<f32>(front.rgb * (1.0 - back.a)
              + back.rgb * (1.0 - front.a) + b * front.a * back.a,
              blendedAlpha) * blendUniforms.uBlend;
          `,
        },
      });
    }
  }
  FlashBlend.extension = { name, type: ExtensionType.BlendMode };
  extensions.add(FlashBlend);
  return FlashBlend;
}

// Hard light: the source decides between multiply and screen.
export const FlashHardLightBlend = flashBlend("hard-light",
  "mix(2.0 * s * d, 1.0 - 2.0 * (1.0 - s) * (1.0 - d), step(vec3(0.5), s))",
  "mix(2.0 * s * d, 1.0 - 2.0 * (1.0 - s) * (1.0 - d), step(vec3<f32>(0.5), s))");
// Overlay: hard light with the roles swapped; the backdrop decides.
export const FlashOverlayBlend = flashBlend("overlay",
  "mix(2.0 * s * d, 1.0 - 2.0 * (1.0 - s) * (1.0 - d), step(vec3(0.5), d))",
  "mix(2.0 * s * d, 1.0 - 2.0 * (1.0 - s) * (1.0 - d), step(vec3<f32>(0.5), d))");
export const FlashDarkenBlend = flashBlend("darken", "min(s, d)", "min(s, d)");
export const FlashLightenBlend = flashBlend("lighten", "max(s, d)", "max(s, d)");
export const FlashDifferenceBlend = flashBlend("difference", "abs(s - d)", "abs(s - d)");
