import { inflateSync } from "node:zlib";

export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function readU32BE(buf: Uint8Array, off: number): number {
  return ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>> 0;
}

function readU32LE(buf: Uint8Array, off: number): number {
  return (buf[off]! | (buf[off + 1]! << 8) | (buf[off + 2]! << 16) | (buf[off + 3]! << 24)) >>> 0;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Samples per pixel per PNG color type. Type 3 (palette) carries one index.
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

interface PngChunks {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  palette: Uint8Array | null;
  trns: Uint8Array | null;
  idat: Buffer[];
}

function parseChunks(bytes: Uint8Array): PngChunks {
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Buffer[] = [];
  while (pos + 8 <= bytes.length) {
    const len = readU32BE(bytes, pos);
    const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = readU32BE(data, 0); height = readU32BE(data, 4);
      bitDepth = data[8]!; colorType = data[9]!; interlace = data[12]!;
    } else if (type === "PLTE") palette = data.slice();
    else if (type === "tRNS") trns = data.slice();
    else if (type === "IDAT") idat.push(Buffer.from(data));
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  return { width, height, bitDepth, colorType, interlace, palette, trns, idat };
}

// Read sample `index` from a scanline at the given bit depth. Samples are
// packed big-endian for sub-byte depths, and 16-bit samples keep the high byte.
function sampleAt(row: Uint8Array, index: number, bitDepth: number): number {
  if (bitDepth === 8) return row[index]!;
  if (bitDepth === 16) return (row[index * 2]! << 8) | row[index * 2 + 1]!;
  const perByte = 8 / bitDepth;
  const byteIdx = Math.floor(index / perByte);
  const shift = 8 - bitDepth * ((index % perByte) + 1);
  return (row[byteIdx]! >> shift) & ((1 << bitDepth) - 1);
}

function unfilter(raw: Uint8Array, height: number, rowBytes: number, bpp: number): Uint8Array {
  const out = new Uint8Array(height * rowBytes);
  const paeth = (a: number, b: number, c: number): number => {
    const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]!;
    const base = y * rowBytes;
    const prevBase = (y - 1) * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const left = i >= bpp ? out[base + i - bpp]! : 0;
      const up = y > 0 ? out[prevBase + i]! : 0;
      const upLeft = y > 0 && i >= bpp ? out[prevBase + i - bpp]! : 0;
      const v = raw[p++]!;
      out[base + i] = filter === 0 ? v
        : filter === 1 ? (v + left) & 0xff
        : filter === 2 ? (v + up) & 0xff
        : filter === 3 ? (v + ((left + up) >> 1)) & 0xff
        : (v + paeth(left, up, upLeft)) & 0xff;
    }
  }
  return out;
}

export function decodePng(bytes: Uint8Array): DecodedImage {
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) throw new Error("not a PNG");
  const { width, height, bitDepth, colorType, interlace, palette, trns, idat } = parseChunks(bytes);
  if (width === 0 || height === 0) throw new Error("missing IHDR");
  if (interlace !== 0) throw new Error("interlaced PNG (Adam7) not supported");
  const channels = CHANNELS[colorType];
  if (channels === undefined) throw new Error(`PNG colorType=${colorType} not supported`);
  if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error(`PNG bitDepth=${bitDepth} not supported`);
  if (colorType === 3 && !palette) throw new Error("palette PNG without PLTE chunk");

  const bitsPerPixel = channels * bitDepth;
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const pixels = unfilter(inflateSync(Buffer.concat(idat)), height, rowBytes, bpp);

  const maxVal = (1 << bitDepth) - 1;
  const scale = (v: number): number => bitDepth === 8 ? v : bitDepth === 16 ? v >> 8 : Math.round((v * 255) / maxVal);
  const rgba = new Uint8Array(width * height * 4);

  // tRNS for gray/RGB marks one sample value as fully transparent.
  const trnsGray = colorType === 0 && trns && trns.length >= 2 ? (trns[0]! << 8) | trns[1]! : null;
  const trnsRgb = colorType === 2 && trns && trns.length >= 6
    ? [(trns[0]! << 8) | trns[1]!, (trns[2]! << 8) | trns[3]!, (trns[4]! << 8) | trns[5]!]
    : null;

  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (colorType === 3) {
        const idx = sampleAt(row, s, bitDepth);
        const po = idx * 3;
        rgba[o] = palette![po]!; rgba[o + 1] = palette![po + 1]!; rgba[o + 2] = palette![po + 2]!;
        rgba[o + 3] = trns && idx < trns.length ? trns[idx]! : 255;
      } else if (colorType === 0) {
        const g = sampleAt(row, s, bitDepth);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = scale(g);
        rgba[o + 3] = trnsGray !== null && g === trnsGray ? 0 : 255;
      } else if (colorType === 2) {
        const r = sampleAt(row, s, bitDepth), g = sampleAt(row, s + 1, bitDepth), b = sampleAt(row, s + 2, bitDepth);
        rgba[o] = scale(r); rgba[o + 1] = scale(g); rgba[o + 2] = scale(b);
        rgba[o + 3] = trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2] ? 0 : 255;
      } else if (colorType === 4) {
        const g = sampleAt(row, s, bitDepth);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = scale(g);
        rgba[o + 3] = scale(sampleAt(row, s + 1, bitDepth));
      } else {
        rgba[o] = scale(sampleAt(row, s, bitDepth));
        rgba[o + 1] = scale(sampleAt(row, s + 1, bitDepth));
        rgba[o + 2] = scale(sampleAt(row, s + 2, bitDepth));
        rgba[o + 3] = scale(sampleAt(row, s + 3, bitDepth));
      }
    }
  }
  return { width, height, rgba };
}

export function decodeBmp(bytes: Uint8Array): DecodedImage {
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error("not a BMP");
  const dataOff = bytes[10]! | (bytes[11]! << 8) | (bytes[12]! << 16) | (bytes[13]! << 24);
  const headerSize = bytes[14]! | (bytes[15]! << 8) | (bytes[16]! << 16) | (bytes[17]! << 24);
  const width = bytes[18]! | (bytes[19]! << 8) | (bytes[20]! << 16) | (bytes[21]! << 24);
  const heightRaw = bytes[22]! | (bytes[23]! << 8) | (bytes[24]! << 16) | (bytes[25]! << 24);
  const bpp = bytes[28]! | (bytes[29]! << 8);
  const comp = bytes[30]! | (bytes[31]! << 8);
  // comp 0 = BI_RGB, 3 = BI_BITFIELDS (masked channels, common for 32-bit).
  if (comp !== 0 && comp !== 3) throw new Error(`BMP compression=${comp} not supported`);
  if (![1, 4, 8, 24, 32].includes(bpp)) throw new Error(`BMP bpp=${bpp} not supported`);
  if (comp === 3 && bpp !== 32) throw new Error(`BMP bitfields only supported for 32bpp (got ${bpp})`);
  if (width <= 0) throw new Error("BMP width must be positive");

  const height = Math.abs(heightRaw);
  const bottomUp = heightRaw > 0;
  const rgba = new Uint8Array(width * height * 4);

  // BITFIELDS masks: inside the header for V4+ (>=52 bytes), otherwise in the
  // 12 bytes right after it. Masks are followed as declared, so both the
  // common BGRA and RGBA byte orders decode correctly.
  let bitFields: { r: number; g: number; b: number; a: number; rShift: number; gShift: number; bShift: number; aShift: number } | null = null;
  if (comp === 3) {
    const off = headerSize >= 52 ? 54 : 14 + headerSize;
    if (off + 12 > bytes.length) throw new Error("BMP bitfields truncated");
    const rMask = readU32LE(bytes, off);
    const gMask = readU32LE(bytes, off + 4);
    const bMask = readU32LE(bytes, off + 8);
    const aMask = headerSize >= 52 ? readU32LE(bytes, off + 12) : 0;
    // Trailing zero count = position of the lowest set bit. Only masks that
    // resolve to a full 8-bit channel are accepted.
    const shift = (m: number): number => m === 0 ? 0 : 31 - Math.clz32(m & -m);
    const ok8 = (m: number): boolean => m !== 0 && ((m >>> shift(m)) === 0xff);
    if (!ok8(rMask) || !ok8(gMask) || !ok8(bMask)) {
      throw new Error(`BMP bitfields need 8-bit R/G/B channels (masks ${rMask.toString(16)}/${gMask.toString(16)}/${bMask.toString(16)})`);
    }
    bitFields = { r: rMask, g: gMask, b: bMask, a: aMask, rShift: shift(rMask), gShift: shift(gMask), bShift: shift(bMask), aShift: shift(aMask) };
  }

  // Palette entries live between the header and the pixel data, 4 bytes each
  // (BGRA). biClrUsed (offset 46) may declare fewer than the bpp maximum.
  let palette: Uint8Array | null = null;
  if (bpp <= 8) {
    const maxColors = bpp === 8 ? 256 : bpp === 4 ? 16 : 2;
    const clrUsed = bytes[46]! | (bytes[47]! << 8) | (bytes[48]! << 16) | (bytes[49]! << 24);
    const count = clrUsed > 0 && clrUsed <= maxColors ? clrUsed : maxColors;
    const pStart = 14 + headerSize;
    if (pStart + count * 4 > bytes.length) throw new Error("BMP palette truncated");
    palette = bytes.subarray(pStart, pStart + count * 4);
  }

  const rowStride = Math.floor((width * bpp + 31) / 32) * 4;
  for (let y = 0; y < height; y++) {
    const row = bottomUp ? height - 1 - y : y;
    const rowStart = dataOff + row * rowStride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (bpp === 24) {
        const s = rowStart + x * 3;
        rgba[o] = bytes[s + 2]!; rgba[o + 1] = bytes[s + 1]!; rgba[o + 2] = bytes[s]!; rgba[o + 3] = 255;
      } else if (bpp === 32) {
        const s = rowStart + x * 4;
        if (bitFields) {
          const v = readU32LE(bytes, s);
          rgba[o] = (v & bitFields.r) >>> bitFields.rShift;
          rgba[o + 1] = (v & bitFields.g) >>> bitFields.gShift;
          rgba[o + 2] = (v & bitFields.b) >>> bitFields.bShift;
          // An explicit alpha mask is authoritative; absent one, assume opaque.
          rgba[o + 3] = bitFields.a === 0 ? 255 : (v & bitFields.a) >>> bitFields.aShift;
        } else {
          rgba[o] = bytes[s + 2]!; rgba[o + 1] = bytes[s + 1]!; rgba[o + 2] = bytes[s]!;
          const a = bytes[s + 3]!;
          rgba[o + 3] = a === 0 ? 255 : a; // BI_RGB 32-bit leaves this byte reserved
        }
      } else {
        const perByte = 8 / bpp;
        const byteIdx = rowStart + Math.floor(x / perByte);
        const shift = 8 - bpp * ((x % perByte) + 1);
        const idx = (bytes[byteIdx]! >> shift) & ((1 << bpp) - 1);
        const po = idx * 4;
        rgba[o] = palette![po + 2]!; rgba[o + 1] = palette![po + 1]!; rgba[o + 2] = palette![po]!; rgba[o + 3] = 255;
      }
    }
  }
  return { width, height, rgba };
}

export function decodeImage(bytes: Uint8Array, mimeType: string): DecodedImage {
  if (mimeType === "image/png") return decodePng(bytes);
  if (mimeType === "image/bmp") return decodeBmp(bytes);
  throw new Error(`preview decode not supported for ${mimeType}`);
}
