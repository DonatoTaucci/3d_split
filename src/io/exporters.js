// Exporters: binary STL, OBJ, 3MF (multi-object), ZIP bundles.
import { zipSync, strToU8 } from 'fflate';

/** @param {{pos:Float32Array, tri:Uint32Array}} m */
export function toSTL(m, name = 'part') {
  const nf = m.tri.length / 3;
  const buf = new ArrayBuffer(84 + nf * 50);
  const dv = new DataView(buf);
  const header = `3D Split - ${name}`.slice(0, 79);
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i) & 0x7f);
  dv.setUint32(80, nf, true);
  let o = 84;
  const p = m.pos;
  for (let f = 0; f < nf; f++) {
    const a = 3 * m.tri[3 * f], b = 3 * m.tri[3 * f + 1], c = 3 * m.tri[3 * f + 2];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (const v of [a, b, c]) {
      dv.setFloat32(o, p[v], true); dv.setFloat32(o + 4, p[v + 1], true); dv.setFloat32(o + 8, p[v + 2], true);
      o += 12;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return new Uint8Array(buf);
}

export function toOBJ(m, name = 'part') {
  const lines = [`# 3D Split`, `o ${name}`];
  const p = m.pos;
  for (let i = 0; i < p.length; i += 3) lines.push(`v ${fmt(p[i])} ${fmt(p[i + 1])} ${fmt(p[i + 2])}`);
  for (let i = 0; i < m.tri.length; i += 3) lines.push(`f ${m.tri[i] + 1} ${m.tri[i + 1] + 1} ${m.tri[i + 2] + 1}`);
  return strToU8(lines.join('\n') + '\n');
}

function fmt(x) {
  return Number.isInteger(x) ? String(x) : x.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
}

function xmlEscape(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

/**
 * 3MF with one object per part (opens as separate objects in Bambu Studio / PrusaSlicer / Cura).
 * @param {{name:string, pos:Float32Array, tri:Uint32Array, color?:string}[]} parts
 */
export function to3MF(parts) {
  const objs = [];
  const items = [];
  const mats = parts.map((p, i) => `<base name="${xmlEscape(p.name)}" displaycolor="${(p.color || '#C8C8C8').toUpperCase()}FF" />`).join('');
  parts.forEach((part, i) => {
    const id = i + 2;
    const v = [];
    const p = part.pos;
    for (let k = 0; k < p.length; k += 3) v.push(`<vertex x="${fmt(p[k])}" y="${fmt(p[k + 1])}" z="${fmt(p[k + 2])}"/>`);
    const t = [];
    for (let k = 0; k < part.tri.length; k += 3) t.push(`<triangle v1="${part.tri[k]}" v2="${part.tri[k + 1]}" v3="${part.tri[k + 2]}"/>`);
    objs.push(`<object id="${id}" name="${xmlEscape(part.name)}" type="model" pid="1" pindex="${i}"><mesh><vertices>${v.join('')}</vertices><triangles>${t.join('')}</triangles></mesh></object>`);
    items.push(`<item objectid="${id}"/>`);
  });
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="it-IT" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
<metadata name="Application">3D Split</metadata>
<resources><basematerials id="1">${mats}</basematerials>${objs.join('\n')}</resources>
<build>${items.join('')}</build>
</model>`;
  const files = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`),
    '3D/3dmodel.model': strToU8(model),
  };
  return zipSync(files, { level: 6 });
}

export function zipFiles(map) {
  return zipSync(map, { level: 6 });
}

export function downloadBytes(bytes, filename, mime = 'application/octet-stream') {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function safeFileName(s) {
  return String(s).replace(/[^\w\-àèéìòù ]+/gi, '_').trim().replace(/\s+/g, '_') || 'parte';
}
