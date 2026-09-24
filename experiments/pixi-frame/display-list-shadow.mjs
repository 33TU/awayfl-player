import {
  Filter,
  GlProgram,
  UniformGroup,
  BlurFilter,
  AlphaFilter,
  Texture,
  TexturePool,
} from "pixi.js";

// Pixi owns all intermediate targets. The blur kernel is Pixi's Gaussian;
// composition preserves Flash's strength, inner, knockout and hideObject modes.
const vertex = `
precision highp float;
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize, uOutputFrame, uOutputTexture;
void main() {
  vec2 p = aPosition * uOutputFrame.zw + uOutputFrame.xy;
  gl_Position = vec4(p.x * 2.0 / uOutputTexture.x - 1.0,
    p.y * 2.0 * uOutputTexture.z / uOutputTexture.y - uOutputTexture.z, 0.0, 1.0);
  vTextureCoord = aPosition * uOutputFrame.zw * uInputSize.zw;
}`;
const fragment = `
precision highp float;
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture, uBlur;
uniform vec4 uInputSize, uInputClamp, uGlowColor, uProps;
uniform vec2 uOffset;
void main() {
  vec4 source = texture(uTexture, vTextureCoord);
  vec2 uv = vTextureCoord - uOffset * uInputSize.zw;
  // Outside the padded source is transparent, including for inner shadows.
  float coverage = step(uInputClamp.x, uv.x) * step(uInputClamp.y, uv.y)
    * step(uv.x, uInputClamp.z) * step(uv.y, uInputClamp.w);
  float blurred = texture(uBlur, clamp(uv, uInputClamp.xy, uInputClamp.zw)).a * coverage;
  float amount = mix(blurred, (1.0 - blurred) * source.a, uProps.y);
  float alpha = clamp(amount * uGlowColor.a * uProps.x, 0.0, 1.0);
  vec4 glow = vec4(uGlowColor.rgb * alpha, alpha);
  if (uProps.w > 0.5) {
    vec4 main = source * (1.0 - uProps.z);
    glow = mix(main + (1.0 - source.a) * glow, main * (1.0 - glow.a) + glow, uProps.y);
  }
  finalColor = glow;
}`;

export function shadowOptions(f) {
  return {
    color: f.color ?? 0,
    alpha: f.alpha ?? 1,
    blurX: f.blurX ?? 4,
    blurY: f.blurY ?? 4,
    strength: f.strength ?? 1,
    quality: f.quality ?? 1,
    inner: !!f.inner,
    knockout: !!f.knockout,
    hideObject: !!f.hideObject,
    distance: f.filterName === "glow" ? 0 : (f.distance ?? 0),
    angle: f.angle ?? 0,
  };
}

export class DisplayListShadowFilter extends Filter {
  constructor(options) {
    const uniforms = new UniformGroup({
      uGlowColor: { value: new Float32Array(4), type: "vec4<f32>" },
      uProps: { value: new Float32Array(4), type: "vec4<f32>" },
      uOffset: { value: new Float32Array(2), type: "vec2<f32>" },
    });
    super({
      glProgram: GlProgram.from({
        vertex,
        fragment,
        name: "flash-display-list-shadow",
      }),
      resources: { shadow: uniforms, uBlur: Texture.EMPTY.source },
    });
    this.options = options;
    this.shadowUniforms = uniforms;
    this.blur = new BlurFilter({
      quality: Math.max(1, Math.min(15, options.quality)),
      kernelSize: 5,
    });
    // Pixi blur uses its input as a ping-pong target above two passes.
    // Keep the unblurred source intact for the final Flash composition.
    this.copy = this.blur.quality > 2 ? new AlphaFilter({ alpha: 1 }) : null;
    const c = options.color;
    uniforms.uniforms.uGlowColor.set([
      ((c >> 16) & 255) / 255,
      ((c >> 8) & 255) / 255,
      (c & 255) / 255,
      options.alpha,
    ]);
    uniforms.uniforms.uProps.set([
      options.strength,
      +options.inner,
      +options.knockout,
      +!options.hideObject,
    ]);
    this.updateScale(1, 1);
  }
  updateScale(x, y) {
    if (this.sx === x && this.sy === y) return;
    this.sx = x;
    this.sy = y;
    const o = this.options,
      angle = (o.angle * Math.PI) / 180;
    this.blur.strengthX = (Math.max(0, o.blurX - 1) * x) / 2;
    this.blur.strengthY = (Math.max(0, o.blurY - 1) * y) / 2;
    const dx = Math.cos(angle) * o.distance * x,
      dy = Math.sin(angle) * o.distance * y;
    this.shadowUniforms.uniforms.uOffset.set([dx, dy]);
    this.shadowUniforms.update();
    // Padding is computed before apply(), so keep it current during tree sync.
    this.padding = Math.ceil(
      this.blur.padding + Math.max(Math.abs(dx), Math.abs(dy)) + 1,
    );
  }
  apply(manager, input, output, clear) {
    const blurred = TexturePool.getSameSizeTexture(input);
    const scratch = this.copy ? TexturePool.getSameSizeTexture(input) : null;
    try {
      if (scratch) this.copy.apply(manager, input, scratch, true);
      this.blur.apply(manager, scratch || input, blurred, true);
      this.resources.uBlur = blurred.source;
      manager.applyFilter(this, input, output, clear);
    } finally {
      // A pooled texture must not remain referenced by a retained bind group.
      this.resources.uBlur = Texture.EMPTY.source;
      TexturePool.returnTexture(blurred);
      if (scratch) TexturePool.returnTexture(scratch);
    }
  }
  destroy() {
    this.copy?.destroy();
    this.blur.destroy();
    this.blur.blurXFilter.destroy();
    this.blur.blurYFilter.destroy();
    super.destroy();
  }
}
