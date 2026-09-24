import { BlendModeFilter, ExtensionType, extensions } from "pixi.js";
import "pixi.js/advanced-blend-modes";

// Both input textures are premultiplied. Evaluate hard-light using straight
// colors, then combine source/backdrop coverage into a premultiplied result.
// This is the same compositing equation used by Ruffle's hardlight shader.
export class FlashHardLightBlend extends BlendModeFilter {
  constructor() {
    super({
      gl: {
        functions: "",
        main: `
          vec3 s = front.rgb / max(front.a, 0.00001);
          vec3 d = back.rgb / max(back.a, 0.00001);
          vec3 b = mix(2.0 * s * d,
            1.0 - 2.0 * (1.0 - s) * (1.0 - d), step(vec3(0.5), s));
          finalColor = vec4(front.rgb * (1.0 - back.a)
            + back.rgb * (1.0 - front.a) + b * front.a * back.a,
            blendedAlpha) * uBlend;
        `,
      },
      gpu: {
        functions: "",
        main: `
          let s = front.rgb / max(front.a, 0.00001);
          let d = back.rgb / max(back.a, 0.00001);
          let b = mix(2.0 * s * d,
            1.0 - 2.0 * (1.0 - s) * (1.0 - d), step(vec3<f32>(0.5), s));
          out = vec4<f32>(front.rgb * (1.0 - back.a)
            + back.rgb * (1.0 - front.a) + b * front.a * back.a,
            blendedAlpha) * blendUniforms.uBlend;
        `,
      },
    });
  }
}
FlashHardLightBlend.extension = {
  name: "hard-light",
  type: ExtensionType.BlendMode,
};
extensions.add(FlashHardLightBlend);
