import { Container, HTMLText, Text } from 'pixi.js';

const DEVICE_FONTS = new Set([
  'Arial', 'Arial Black', 'Verdana', 'Tahoma', 'Times New Roman',
  'Courier New', 'Georgia', 'Trebuchet MS',
]);
const clamp = value => Math.max(0, Math.min(1, value));
const colorHex = value => '#' + (value & 0xffffff).toString(16).padStart(6, '0');
const escapeHTML = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const transformRGB = (rgb, color) => [16, 8, 0].map((shift, i) => Math.round(clamp(
  ((rgb >>> shift) & 255) / 255 * color[i] + color[i + 4] / 255,
) * 255)).reduce((value, channel) => (value << 8) | channel, 0);
const styleFor = spec => ({
  fontFamily: spec.fontFamily, fontSize: spec.fontSize,
  fontWeight: spec.fontWeight, fontStyle: spec.fontStyle,
  letterSpacing: spec.letterSpacing, fill: 0xffffff,
});
const markupFor = (runs, color) => runs.map(run =>
  `<span style="color:${colorHex(transformRGB(run.color, color))}">${escapeHTML(run.text)}</span>`
).join('');
const colorRuns = (text, colors) => {
  const runs = [];
  for (let i = 0; i < text.length; i++) {
    const rgb = colors[i];
    if (runs.at(-1)?.color === rgb) runs.at(-1).text += text[i];
    else runs.push({ text: text[i], color: rgb });
  }
  return runs;
};

// TextSprite owns the glyph geometry while its parent TextField retains
// background, border, input behavior and Flash layout. Only replace a glyph
// run that can be represented by one browser font and one Pixi Text object.
export function describeNativeText(node) {
  if (node?.assetType !== '[asset TextSprite]') return null;
  const field = node.parentTextField;
  const value = field?._iText;
  const formats = field?._textFormats;
  const format = formats?.[0];
  if (!field || field.type !== 'dynamic' || field.selectable ||
      !value || value.length > 256 || value !== field.text ||
      /[\r\t]/.test(value) || field._labelData ||
      !formats?.length || formats.length > 16 || format.bitmap ||
      !DEVICE_FONTS.has(format.font_name) ||
      format.font_table?.assetType !== '[asset TesselatedFontTable]' ||
      !Number.isFinite(format.size) || format.size <= 0 ||
      !Number.isFinite(format.letterSpacing) ||
      !Number.isFinite(field.char_positions_x?.[0]) ||
      !Number.isFinite(field.char_positions_y?.[0]) ||
      node.mask) return null;
  let sourceColor = format.hasPropertySet('color') ? format.color : field.textColor;
  if (!Number.isFinite(sourceColor)) return null;
  const glyphText = value.replace(/\n/g, '');
  if (!glyphText) return null;
  let runs;
  let charColors;
  if (formats.length > 1) {
    const perChar = field.tf_per_char;
    if (perChar?.length !== glyphText.length) return null;
    charColors = [];
    for (let i = 0; i < glyphText.length; i++) {
      const runFormat = perChar[i];
      if (!formats.includes(runFormat) || runFormat.bitmap ||
          runFormat.font_name !== format.font_name || runFormat.size !== format.size ||
          runFormat.bold !== format.bold || runFormat.italic !== format.italic ||
          runFormat.letterSpacing !== format.letterSpacing) return null;
      const runColor = runFormat.hasPropertySet('color') ? runFormat.color : field.textColor;
      if (!Number.isFinite(runColor)) return null;
      const rgba = runColor >>> 0;
      if (rgba > 0xffffff && (rgba >>> 24) !== 255) return null;
      charColors.push(rgba & 0xffffff);
    }
    runs = colorRuns(glyphText, charColors);
    if (runs.length < 2) {
      sourceColor = runs[0].color;
      runs = null;
    }
  }
  const rgba = sourceColor >>> 0;
  const alpha = rgba > 0xffffff ? (rgba >>> 24) / 255 : 1;
  let lines;
  const starts = field.lines_charIdx_start, ends = field.lines_charIdx_end;
  if (field._wordWrap || value.includes('\n') || starts?.length > 1) {
    if (!starts?.length || starts.length !== ends?.length || starts.length > 12)
      return null;
    lines = [];
    let previousEnd = 0;
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i], end = ends[i];
      if (start !== previousEnd || end < start || end > glyphText.length ||
          !Number.isFinite(field.char_positions_x?.[start]) ||
          !Number.isFinite(field.char_positions_y?.[start])) return null;
      const text = glyphText.slice(start, end);
      const lineRuns = charColors ? colorRuns(text, charColors.slice(start, end)) : null;
      lines.push({ text, runs: lineRuns?.length > 1 ? lineRuns : null,
        color: lineRuns?.[0]?.color ?? (rgba & 0xffffff),
        x: field.char_positions_x[start], y: field.char_positions_y[start] });
      previousEnd = end;
    }
    if (previousEnd !== glyphText.length) return null;
  }
  return {
    kind: lines ? 'lines' : runs ? 'html' : 'text',
    lines,
    runs,
    text: value,
    fontFamily: format.font_name,
    fontSize: format.size,
    fontWeight: format.bold ? 'bold' : 'normal',
    fontStyle: format.italic ? 'italic' : 'normal',
    letterSpacing: format.letterSpacing,
    x: field.char_positions_x[0],
    y: field.char_positions_y[0],
    color: rgba & 0xffffff,
    alpha,
  };
}

export function syncNativeText(record, spec, color, world, dirty) {
  const key = JSON.stringify([
    spec.kind, spec.text, spec.runs, spec.lines, spec.fontFamily, spec.fontSize, spec.fontWeight,
    spec.fontStyle, spec.letterSpacing, spec.x, spec.y,
  ]);
  if (record.nativeTextKey !== key) {
    // Replacing the Pixi Text object is a structural change that makes Pixi
    // rebuild the whole render group's instructions (the HUD's 6000
    // containers for an FPS counter or a chat line). Keep the object and
    // update it in place while its layout kind and font stay the same.
    const layoutKey = JSON.stringify([spec.kind, spec.fontFamily, spec.fontSize, spec.fontWeight,
      spec.fontStyle, spec.letterSpacing, spec.kind === 'lines' ? spec.lines.filter(l => l.text).map(l => !!l.runs) : null]);
    // Pixi's HTMLText ignores a text change that arrives while its previous
    // texture is still being generated (and stays stuck if that generation
    // failed), so an HTML label set twice in quick succession, like the room
    // name on a room change, kept the old text. Replace such an object.
    const generating = text => Object.values(text?._gpuData || {}).some(g => g?.generatingTexture);
    const busy = record.nativeText && (generating(record.nativeText) ||
      record.nativeText.children?.some(generating));
    const reusable = record.nativeText && record.nativeLayoutKey === layoutKey && !busy;
    if (reusable) {
      if (spec.kind === 'lines') {
        let index = 0;
        for (const line of spec.lines) {
          if (!line.text) continue;
          const text = record.nativeText.children[index++];
          if (!line.runs && text.text !== line.text) text.text = line.text;
          text.position.set(line.x, line.y);
        }
      } else {
        if (spec.kind === 'text' && record.nativeText.text !== spec.text) record.nativeText.text = spec.text;
        record.nativeText.position.set(spec.x, spec.y);
      }
      record.nativeTextKey = key;
      if (spec.kind === 'html') record.nativePaintKey = null;
      dirty(record, 'text');
    } else {
    record.nativeText?.destroy({ children: true });
    record.nativeLayoutKey = layoutKey;
    if (spec.kind === 'lines') {
      record.nativeText = new Container();
      for (const line of spec.lines) {
        if (!line.text) continue;
        const TextClass = line.runs ? HTMLText : Text;
        const text = new TextClass({ text: line.runs ? '' : line.text, style: styleFor(spec) });
        text.position.set(line.x, line.y);
        record.nativeText.addChild(text);
      }
    } else {
      const TextClass = spec.kind === 'html' ? HTMLText : Text;
      record.nativeText = new TextClass({ text: spec.kind === 'html' ? '' : spec.text, style: styleFor(spec) });
      record.nativeText.position.set(spec.x, spec.y);
    }
    record.nativeTextKey = key;
    record.nativePaintKey = null;
    dirty(record, 'text');
    }
  }
  // Pixi Text is rasterized into a texture. Flash fields are often scaled by
  // the game and then by the stage, so renderer resolution (1 here) is too low.
  // Match the backing texture to its final pixel scale without changing layout.
  const scale = Math.max(Math.hypot(world.a, world.b), Math.hypot(world.c, world.d));
  const resolution = Math.min(4, Math.max(1, Math.ceil(scale)));
  const textObjects = spec.kind === 'lines' ? record.nativeText.children : [record.nativeText];
  for (const text of textObjects) if (text.resolution !== resolution) {
    text.resolution = resolution;
    dirty(record, 'text-resolution');
  }
  const tint = spec.kind === 'text' ? transformRGB(spec.color, color) : 0xffffff;
  const alpha = clamp(spec.alpha * color[3] + color[7] / 255);
  if (spec.kind === 'html') {
    const markup = markupFor(spec.runs, color);
    if (record.nativePaintKey !== markup) {
      record.nativeText.text = markup;
      record.nativePaintKey = markup;
      dirty(record, 'text-paint');
    }
  } else if (spec.kind === 'lines') {
    let index = 0;
    for (const line of spec.lines) {
      if (!line.text) continue;
      const text = record.nativeText.children[index++];
      if (line.runs) {
        const markup = markupFor(line.runs, color);
        if (text.text !== markup) { text.text = markup; dirty(record, 'text-paint'); }
        text.tint = 0xffffff;
      } else {
        const lineTint = transformRGB(line.color, color);
        if (text.tint !== lineTint) dirty(record, 'paint');
        text.tint = lineTint;
      }
    }
  }
  if (record.nativeText.tint !== tint || record.nativeText.alpha !== alpha)
    dirty(record, 'paint');
  record.nativeText.tint = tint;
  record.nativeText.alpha = alpha;
  return record.nativeText;
}

export function retireNativeText(record) {
  if (!record.nativeText) return;
  record.nativeText.destroy({ children: true });
  record.nativeText = null;
  record.nativeTextKey = null;
  record.nativeLayoutKey = null;
  record.nativePaintKey = null;
}
