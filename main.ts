// png-squeeze-01 entry v1: lossless PNG re-encoder.
// Decodes the stored RGBA screenshot, reduces the colour type per instance
// (palette / grey / grey+alpha / RGB / RGBA), tries three whole-image filter
// candidates (None, Paeth, minsum-adaptive) and keeps the smallest real
// zlib level-9 deflate, and writes one IDAT stream.
// Deterministic: no clock, no randomness, no environment reads.

import { inflateSync, deflateSync, constants as zlibConstants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---- CRC32 (PNG polynomial, table built once, deterministically) ----
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc);
  return out;
}

// ---- PNG decode: stored RGBA, bit depth 8, non-interlaced ----
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array; // width * height * 4
}

function decodePng(bytes: Uint8Array): Decoded {
  // Signature
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error('not a PNG');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (off < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + off, 12);
    const len = view.getUint32(0);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, data.length);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error('expected 8-bit RGBA input');
  const total = idat.reduce((a, b) => a + b.length, 0);
  const z = new Uint8Array(total);
  let p = 0;
  for (const part of idat) {
    z.set(part, p);
    p += part.length;
  }
  const raw = inflateSync(z);
  const stride = width * 4;
  const rgba = new Uint8Array(width * height * 4);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : rgba.subarray((y - 1) * stride, y * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? row[x - 4] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= 4 ? prev[x - 4] : 0;
      const v = raw[src + x];
      let f = 0;
      if (filter === 0) f = v;
      else if (filter === 1) f = v + a;
      else if (filter === 2) f = v + b;
      else if (filter === 3) f = v + ((a + b) >> 1);
      else if (filter === 4) f = v + paeth(a, b, c);
      else throw new Error('bad filter ' + filter);
      row[x] = f & 0xff;
    }
    src += stride;
  }
  return { width, height, rgba };
}

// ---- Colour-type reduction ----
type Repr =
  | { kind: 'palette'; palette: Uint8Array; trns: Uint8Array | null; index: Uint8Array }
  | { kind: 'grey'; trnsGrey: number | null; data: Uint8Array }
  | { kind: 'grey-alpha'; data: Uint8Array }
  | { kind: 'rgb'; trnsRgb: [number, number, number] | null; data: Uint8Array }
  | { kind: 'rgba'; data: Uint8Array };

function reduce(img: Decoded): Repr {
  const { width, height, rgba } = img;
  const n = width * height;
  const uniq = new Map<number, number>();
  let allGrey = true;
  let allOpaque = true;
  // transparent-colour bookkeeping: RGB key -> alpha seen (0 means fully transparent)
  const transparentRgb = new Map<number, number>(); // rgb key -> alpha (only for pixels with a<255)
  const transparentGrey = new Map<number, number>(); // grey value -> alpha
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    const key = r * 16777216 + g * 65536 + b * 256 + a;
    if (!uniq.has(key)) uniq.set(key, uniq.size);
    if (r !== g || g !== b) allGrey = false;
    if (a !== 255) {
      allOpaque = false;
      const rgbKey = r * 65536 + g * 256 + b;
      if (!transparentRgb.has(rgbKey)) transparentRgb.set(rgbKey, a);
      else if (transparentRgb.get(rgbKey) !== a) transparentRgb.set(rgbKey, -1); // same rgb, mixed alpha
      if (r === g && g === b) {
        if (!transparentGrey.has(r)) transparentGrey.set(r, a);
        else if (transparentGrey.get(r) !== a) transparentGrey.set(r, -1);
      }
    }
  }

  // 1. Palette: at most 256 distinct RGBA colours. Entries are ordered by
  // luminance (grey value for grey images) so neighbouring pixels get nearby
  // indices and the row filters can compress the index stream; first-seen
  // order would scatter similar colours across the index space.
  if (uniq.size <= 256) {
    const sorted = [...uniq.keys()].sort((ka, kb) => {
      const ra = (ka >> 24) & 0xff;
      const ga = (ka >> 16) & 0xff;
      const ba = (ka >> 8) & 0xff;
      const rb = (kb >> 24) & 0xff;
      const gb = (kb >> 16) & 0xff;
      const bb = (kb >> 8) & 0xff;
      const la = 299 * ra + 587 * ga + 114 * ba;
      const lb = 299 * rb + 587 * gb + 114 * bb;
      if (la !== lb) return la - lb;
      if (ra !== rb) return ra - rb;
      if (ga !== gb) return ga - gb;
      if (ba !== bb) return ba - bb;
      return (ka & 0xff) - (kb & 0xff);
    });
    const remap = new Map<number, number>();
    sorted.forEach((key, idx) => remap.set(key, idx));
    const palette = new Uint8Array(uniq.size * 3);
    const alphas = new Uint8Array(uniq.size);
    const index = new Uint8Array(n);
    // Sorted order (deterministic).
    for (const key of sorted) {
      const idx = remap.get(key)!;
      const a = key & 0xff;
      const b = (key >> 8) & 0xff;
      const g = (key >> 16) & 0xff;
      const r = (key >> 24) & 0xff;
      palette[idx * 3] = r;
      palette[idx * 3 + 1] = g;
      palette[idx * 3 + 2] = b;
      alphas[idx] = a;
    }
    for (let i = 0; i < n; i++) {
      const key = rgba[i * 4] * 16777216 + rgba[i * 4 + 1] * 65536 + rgba[i * 4 + 2] * 256 + rgba[i * 4 + 3];
      index[i] = remap.get(key)!;
    }
    let trns: Uint8Array | null = null;
    let last = -1;
    for (let i = 0; i < uniq.size; i++) if (alphas[i] !== 255) last = i;
    if (last >= 0) trns = alphas.subarray(0, last + 1);
    return { kind: 'palette', palette, trns, index };
  }

  // 2. Grey.
  if (allGrey) {
    if (allOpaque) {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = rgba[i * 4];
      return { kind: 'grey', trnsGrey: null, data };
    }
    // Grey + tRNS works only when a single grey value is transparent and fully so.
    if (transparentGrey.size === 1) {
      const [gv, av] = [...transparentGrey.entries()][0];
      if (av === 0) {
        const data = new Uint8Array(n);
        for (let i = 0; i < n; i++) data[i] = rgba[i * 4];
        return { kind: 'grey', trnsGrey: gv, data };
      }
    }
    const data = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      data[i * 2] = rgba[i * 4];
      data[i * 2 + 1] = rgba[i * 4 + 3];
    }
    return { kind: 'grey-alpha', data };
  }

  // 3. RGB, opaque.
  if (allOpaque) {
    const data = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      data[i * 3] = rgba[i * 4];
      data[i * 3 + 1] = rgba[i * 4 + 1];
      data[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return { kind: 'rgb', trnsRgb: null, data };
  }

  // 4. RGB + tRNS: exactly one RGB value fully transparent, everything else opaque.
  if (transparentRgb.size === 1) {
    const [rgbKey, av] = [...transparentRgb.entries()][0];
    if (av === 0) {
      const data = new Uint8Array(n * 3);
      for (let i = 0; i < n; i++) {
        data[i * 3] = rgba[i * 4];
        data[i * 3 + 1] = rgba[i * 4 + 1];
        data[i * 3 + 2] = rgba[i * 4 + 2];
      }
      const r = (rgbKey >> 16) & 0xff;
      const g = (rgbKey >> 8) & 0xff;
      const b = rgbKey & 0xff;
      return { kind: 'rgb', trnsRgb: [r, g, b], data };
    }
  }

  // 5. RGBA fallback.
  return { kind: 'rgba', data: rgba };
}

// ---- Filtering: three whole-image candidates, the smallest real deflate wins ----
// minsum (adaptive per row, by minimum signed-byte sum) is a proxy: on flat
// screenshots it can lose badly to no filtering at all, because raw bytes
// repeat exactly and LZ77 matches them, while filtering breaks the repeats.
// So measure: build None, Paeth-fixed and minsum-adaptive streams, deflate
// each at level 9, keep the smallest; then retry the winner with the
// Z_FILTERED strategy and keep that if smaller still. All deterministic.
function filterOne(data: Uint8Array, width: number, height: number, bpp: number, f: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(height * (stride + 1));
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : data.subarray((y - 1) * stride, y * stride);
    out[pos] = f;
    const dst = out.subarray(pos + 1, pos + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) pred = paeth(a, b, c);
      dst[x] = (row[x] - pred) & 0xff;
    }
    pos += stride + 1;
  }
  return out;
}

function filterMinsum(data: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(height * (stride + 1));
  const cand = new Uint8Array(stride);
  let outPos = 0;
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : data.subarray((y - 1) * stride, y * stride);
    let bestFilter = 0;
    let bestScore = Infinity;
    let bestRow: Uint8Array | null = null;
    for (let f = 0; f < 5; f++) {
      let score = 0;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prev ? prev[x] : 0;
        const c = prev && x >= bpp ? prev[x - bpp] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) pred = paeth(a, b, c);
        const v = (row[x] - pred) & 0xff;
        cand[x] = v;
        score += v >= 128 ? 256 - v : v;
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = f;
        bestRow = cand.slice();
      }
    }
    out[outPos++] = bestFilter;
    out.set(bestRow!, outPos);
    outPos += stride;
  }
  return out;
}

function bestDeflate(data: Uint8Array, width: number, height: number, bpp: number): Uint8Array {
  const streams = [filterOne(data, width, height, bpp, 0), filterOne(data, width, height, bpp, 4), filterMinsum(data, width, height, bpp)];
  let bestStream = streams[0];
  let best = deflateSync(streams[0], { level: 9 });
  for (let i = 1; i < streams.length; i++) {
    const z = deflateSync(streams[i], { level: 9 });
    if (z.length < best.length) {
      best = z;
      bestStream = streams[i];
    }
  }
  const alt = deflateSync(bestStream, { level: 9, strategy: zlibConstants.Z_FILTERED });
  if (alt.length < best.length) best = alt;
  return best;
}

// ---- Encode one image ----
function encode(img: Decoded): Uint8Array {
  const { width, height } = img;
  const repr = reduce(img);
  let colorType: number;
  let bpp: number;
  let data: Uint8Array;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  if (repr.kind === 'palette') {
    colorType = 3;
    bpp = 1;
    data = repr.index;
    plte = repr.palette;
    trns = repr.trns;
  } else if (repr.kind === 'grey') {
    colorType = 0;
    bpp = 1;
    data = repr.data;
    if (repr.trnsGrey !== null) {
      trns = new Uint8Array(2);
      trns[0] = 0;
      trns[1] = repr.trnsGrey;
    }
  } else if (repr.kind === 'grey-alpha') {
    colorType = 4;
    bpp = 2;
    data = repr.data;
  } else if (repr.kind === 'rgb') {
    colorType = 2;
    bpp = 3;
    data = repr.data;
    if (repr.trnsRgb) {
      trns = new Uint8Array(6);
      trns[0] = 0;
      trns[1] = repr.trnsRgb[0];
      trns[2] = 0;
      trns[3] = repr.trnsRgb[1];
      trns[4] = 0;
      trns[5] = repr.trnsRgb[2];
    }
  } else {
    colorType = 6;
    bpp = 4;
    data = repr.data;
  }

  const z = bestDeflate(data, width, height, bpp);

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace

  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts: Uint8Array[] = [sig, chunk('IHDR', ihdr)];
  if (plte) parts.push(chunk('PLTE', plte));
  if (trns) parts.push(chunk('tRNS', trns));
  parts.push(chunk('IDAT', z));
  parts.push(chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

// ---- Main: every instance in the input dir, one run ----
for (const id of readdirSync(INPUT_DIR).sort()) {
  const bytes = readFileSync(join(INPUT_DIR, id, 'image.png'));
  const img = decodePng(new Uint8Array(bytes));
  const png = encode(img);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
}
