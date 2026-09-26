// Snapshot everything packAttributes reads, plus buffer revisions for in-place
// edits. Target storage/offset matter too: a rebuilt batch may relocate a mesh.
// Reuse scratch storage on comparisons; retain a copy only when actually packed.
export function vectorInputs(element, target, index, textureId, out = [], withTransform = true) {
  const g = element.geometry, r = element.renderable, t = element.transform;
  out.length = 0;
  out.push(target, index, element.attributeOffset, element.attributeSize, g, element.color);
  // With instanced transforms the matrix lives in a table, not the vertices.
  if (withTransform) out.push(t.a, t.b, t.c, t.d, t.tx, t.ty);
  out.push(
    textureId, element.roundPixels, element.texture?.textureMatrix,
    element.texture?.textureMatrix?._updateID);
  if (g) for (const name of ["aPosition", "aUV", "aCurve"]) {
    const b = g.attributes[name]?.buffer;
    out.push(b, b?.data, b?._updateID);
  } else out.push(element.geometryData, element.indexOffset, element.indexSize);
  const rect = r.flashRect;
  out.push(rect?.width ?? 1, rect?.height ?? 1, rect?.x ?? 0, rect?.y ?? 0,
    r.flashRadial || 0);
  for (let j = 0; j < 4; j++) out.push(r.flashMultiply?.[j] ?? 1);
  for (let j = 0; j < 4; j++) out.push(r.flashOffset?.[j] ?? 0);
  return out;
}

export function sameVectorInputs(a, b) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
