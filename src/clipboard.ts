import { execFile } from "node:child_process";
import type { ClipboardImage } from "./types.js";

const READ_TIMEOUT_MS = 5000;
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;

const SUPPORTED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

function normalizeMimeType(raw: string): string {
  return raw.split(";")[0]?.trim().toLowerCase() ?? raw.toLowerCase();
}

function run(cmd: string, args: string[]): Promise<{ stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, {
      timeout: READ_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: "buffer",
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve({ stdout: stdout as Buffer });
    });
    child.on("error", reject);
  });
}

function isWayland(): boolean {
  return Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === "wayland";
}

async function listTypes(): Promise<string[]> {
  try {
    if (isWayland()) {
      const { stdout } = await run("wl-paste", ["--list-types"]);
      return stdout.toString("utf8").split("\n").map(normalizeMimeType).filter(Boolean);
    }
    if (process.env.DISPLAY) {
      const { stdout } = await run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]);
      return stdout.toString("utf8").split("\n").map(normalizeMimeType).filter(Boolean);
    }
  } catch { /* tool missing */ }
  return [];
}

const MIME_PRIORITY = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"];

export async function readClipboardImage(): Promise<ClipboardImage | null> {
  if (process.platform !== "linux") {
    throw new Error("clipboard read is Linux-only (Wayland/X11) for now");
  }
  const types = await listTypes();
  if (types.length === 0) {
    if (isWayland()) {
      throw new Error("wl-paste not found or no image in clipboard (need package wl-clipboard)");
    }
    if (process.env.DISPLAY) {
      throw new Error("xclip not found or no image in clipboard (need package xclip)");
    }
    throw new Error("no Wayland/X11 clipboard available (set WAYLAND_DISPLAY or DISPLAY, and install wl-clipboard or xclip)");
  }
  const mime = MIME_PRIORITY.find((m) => types.includes(m));
  if (!mime) {
    const images = types.filter((t) => t.startsWith("image/"));
    if (images.length > 0) throw new Error(`clipboard image format not supported (${images.join(", ")})`);
    return null;
  }

  const { stdout } =
    isWayland()
      ? await run("wl-paste", ["--type", mime])
      : await run("xclip", ["-selection", "clipboard", "-t", mime, "-o"]);

  if (stdout.length === 0) return null;
  if (SUPPORTED_MIME_TYPES.has(mime)) {
    return { bytes: new Uint8Array(stdout), mimeType: mime };
  }
  return null;
}
