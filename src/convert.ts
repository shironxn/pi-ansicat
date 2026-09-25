import { execFile } from "node:child_process";

// Formats the native decoder cannot read, converted to PNG via a system
// tool. No converter installed = no preview, never a wrong one.
const CONVERTIBLE = new Set(["image/jpeg", "image/webp", "image/gif"]);

const CONVERT_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

type Converter = { cmd: string; args: string[] };

// Tried in order. Each reads the image from stdin and writes PNG to stdout.
const CONVERTERS: Converter[] = [
  { cmd: "magick", args: ["-", "png:-"] },
  { cmd: "convert", args: ["-", "png:-"] },
  { cmd: "ffmpeg", args: ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-f", "image2pipe", "-vcodec", "png", "pipe:1"] },
];

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// ImageMagick sniffs content itself, so bytes whose magic does not match the
// declared MIME could reach whatever coders the system policy allows. Gate on
// magic before spawning.
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  "image/jpeg": (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.length >= 6 && b.toString("latin1", 0, 6).startsWith("GIF8"),
  "image/webp": (b) => b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP",
};

function isPng(bytes: Buffer): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return false;
  return true;
}

function runConverter(c: Converter, input: Uint8Array): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = execFile(c.cmd, c.args, {
      timeout: CONVERT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "buffer",
    }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const out = stdout as Buffer;
      resolve(isPng(out) ? out : null);
    });
    child.on("error", () => resolve(null));
    if (child.stdin) {
      child.stdin.on("error", () => { /* converter died early; callback handles it */ });
      child.stdin.end(Buffer.from(input));
    }
  });
}

/**
 * Return PNG bytes for an image the native decoder cannot handle.
 * Returns null when the format needs no conversion, or when no converter is
 * available or it failed. Callers treat null as "no preview".
 */
export async function toPngForPreview(bytes: Uint8Array, mimeType: string): Promise<Uint8Array | null> {
  if (!CONVERTIBLE.has(mimeType)) return null;
  const magic = MAGIC[mimeType];
  if (magic && !magic(Buffer.from(bytes))) return null;
  for (const c of CONVERTERS) {
    const out = await runConverter(c, bytes);
    if (out) return new Uint8Array(out);
  }
  return null;
}
