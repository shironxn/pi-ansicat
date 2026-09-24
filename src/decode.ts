import { inflateSync } from "node:zlib";

export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function readU32BE(buf: Uint8Array, off: number): number {
  return ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>> 0;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodePng(bytes: Uint8Array): DecodedImage {
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) throw new Error("not a PNG");
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
  const idatChunks: Buffer[] = [];
  while (pos + 8 <= bytes.length) {
    const len = readU32BE(bytes, pos), type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { width = readU32BE(data, 0); height = readU32BE(data, 4); bitDepth = data[8]!; colorType = data[9]!; interlace = data[12]!; }
    else if (type === "IDAT") idatChunks.push(Buffer.from(data));
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (width === 0 || height === 0) throw new Error("missing IHDR");
  if (interlace !== 0) throw new Error("interlaced PNG (Adam7) not supported");
  if (bitDepth !== 8 || (colorType !== 0 && colorType !== 2 && colorType !== 4 && colorType !== 6)) {
    throw new Error(`PNG bitDepth=${bitDepth} colorType=${colorType} not supported (8-bit gray/RGB/gray-alpha/RGBA only)`);
  }
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 4 ? 2 : 1;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idatChunks));
  const rgba = new Uint8Array(width * height * 4);
  let p = 0;
  const paeth = (a: number, b: number, c: number): number => {
    const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]!;
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? cur[i - channels]! : 0, up = prev[i]!, upLeft = i >= channels ? prev[i - channels]! : 0, v = raw[p++]!;
      cur[i] = filter === 0 ? v : filter === 1 ? (v + left) & 0xff : filter === 2 ? (v + up) & 0xff : filter === 3 ? (v + ((left + up) >> 1)) & 0xff : (v + paeth(left, up, upLeft)) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, s = x * channels;
      if (channels === 1) { rgba[o] = rgba[o + 1] = rgba[o + 2] = cur[s]!; rgba[o + 3] = 255; }
      else if (channels === 2) { rgba[o] = rgba[o + 1] = rgba[o + 2] = cur[s]!; rgba[o + 3] = cur[s + 1]!; }
      else if (channels === 3) { rgba[o] = cur[s]!; rgba[o + 1] = cur[s + 1]!; rgba[o + 2] = cur[s + 2]!; rgba[o + 3] = 255; }
      else { rgba[o] = cur[s]!; rgba[o + 1] = cur[s + 1]!; rgba[o + 2] = cur[s + 2]!; rgba[o + 3] = cur[s + 3]!; }
    }
    prev = cur;
  }
  return { width, height, rgba };
}

export function decodeBmp(bytes: Uint8Array): DecodedImage {
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error("not a BMP");
  const dataOff = bytes[10]! | (bytes[11]! << 8) | (bytes[12]! << 16) | (bytes[13]! << 24);
  const width = bytes[18]! | (bytes[19]! << 8) | (bytes[20]! << 16) | (bytes[21]! << 24);
  const heightRaw = bytes[22]! | (bytes[23]! << 8) | (bytes[24]! << 16) | (bytes[25]! << 24);
  const bpp = bytes[28]! | (bytes[29]! << 8), comp = bytes[30]!;
  if (bpp !== 24 || comp !== 0) throw new Error(`BMP bpp=${bpp} comp=${comp} not supported`);
  const height = Math.abs(heightRaw);
  const bottomUp = heightRaw > 0;
  const stride = (width * 3 + 3) & ~3;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = bottomUp ? height - 1 - y : y;
    for (let x = 0; x < width; x++) {
      const s = dataOff + row * stride + x * 3, o = (y * width + x) * 4;
      rgba[o] = bytes[s + 2]!; rgba[o + 1] = bytes[s + 1]!; rgba[o + 2] = bytes[s]!; rgba[o + 3] = 255;
    }
  }
  return { width, height, rgba };
}

export function decodeImage(bytes: Uint8Array, mimeType: string): DecodedImage {
  if (mimeType === "image/png") return decodePng(bytes);
  if (mimeType === "image/bmp") return decodeBmp(bytes);
  throw new Error(`preview decode not supported for ${mimeType}`);
}
