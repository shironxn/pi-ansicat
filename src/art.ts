import type { DecodedImage } from "./decode.js";

const RESET = "\x1b[0m";

export function renderHalfBlocks(img: DecodedImage, maxCols: number): string[] {
  const cols = Math.max(20, Math.min(120, maxCols));
  const scale = cols / img.width;
  // Extreme aspect ratios (a 1×64M-pixel PNG passes the decode guards) would
  // render billions of lines before buildPreview's shrink loop can run.
  const rows = Math.min(4096, Math.max(1, Math.round(img.height * scale * 0.5)));
  const w = cols;
  const h = rows * 2;

  const px = (x: number, y: number): [number, number, number] => {
    const sx = Math.min(img.width - 1, Math.floor((x / w) * img.width));
    const sy = Math.min(img.height - 1, Math.floor((y / h) * img.height));
    const o = (sy * img.width + sx) * 4;
    const a = img.rgba[o + 3]! / 255;
    const r = Math.round(img.rgba[o]! * a);
    const g = Math.round(img.rgba[o + 1]! * a);
    const b = Math.round(img.rgba[o + 2]! * a);
    return [r, g, b];
  };

  const lines: string[] = [];
  for (let y = 0; y < h; y += 2) {
    let line = "";
    for (let x = 0; x < w; x++) {
      const [tr, tg, tb] = px(x, y);
      const [br, bg, bb] = px(x, Math.min(h - 1, y + 1));
      line += `\x1b[38;2;${tr};${tg};${tb};48;2;${br};${bg};${bb}m▀`;
    }
    lines.push(line + RESET);
  }
  return lines;
}
