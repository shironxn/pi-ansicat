import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { ClipboardImage } from "./types.js";

const READ_TIMEOUT_MS = 5000;
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;

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

async function runQuietly(cmd: string, args: string[]): Promise<Buffer | undefined> {
  try { return (await run(cmd, args)).stdout; } catch { return undefined; }
}

export type ClipboardRunner = (cmd: string, args: string[]) => Promise<Buffer | undefined>;

function isWayland(): boolean {
  return Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === "wayland";
}

type ClipboardBackend = "wayland" | "x11";

// `ok: false` means the tool is missing or failed, which is different from a
// clipboard that exists but offers no types.
async function queryTypes(backend: ClipboardBackend): Promise<{ ok: boolean; types: string[] }> {
  try {
    const { stdout } = backend === "wayland"
      ? await run("wl-paste", ["--list-types"])
      : await run("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"]);
    return { ok: true, types: stdout.toString("utf8").split("\n").map(normalizeMimeType).filter(Boolean) };
  } catch {
    return { ok: false, types: [] };
  }
}

// An Xwayland session may have no wl-clipboard installed while xclip works, so
// fall back to X11 only when the Wayland query itself fails. An empty clipboard
// is a successful query and must not be replaced with a stale X11 one.
async function detectClipboard(): Promise<{ backend: ClipboardBackend; types: string[] } | null> {
  if (isWayland()) {
    const wayland = await queryTypes("wayland");
    if (wayland.ok) return { backend: "wayland", types: wayland.types };
  }
  if (process.env.DISPLAY) {
    const x11 = await queryTypes("x11");
    if (x11.ok) return { backend: "x11", types: x11.types };
  }
  return null;
}

const MIME_PRIORITY = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"];

// A copied file arrives as a file:// URI list; paste the paths, not the URIs.
export function parseUriList(raw: string): string[] {
  const paths: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#") || !value.startsWith("file://") || value === "file://") continue;
    try { paths.push(fileURLToPath(value)); } catch { /* malformed URI */ }
  }
  return paths;
}

async function readWaylandText(): Promise<string | null> {
  const uri = await runQuietly("wl-paste", ["--no-newline", "--type", "text/uri-list"]);
  const paths = uri ? parseUriList(uri.toString("utf8")) : [];
  if (paths.length > 0) return paths.join("\n");

  const text = await runQuietly("wl-paste", ["--no-newline", "--type", "text"]);
  return text && text.length > 0 ? text.toString("utf8") : null;
}

export async function readX11Text(runCommand: ClipboardRunner = runQuietly): Promise<string | null> {
  const uri = await runCommand("xclip", ["-selection", "clipboard", "-t", "text/uri-list", "-o"]);
  const paths = uri ? parseUriList(uri.toString("utf8")) : [];
  if (paths.length > 0) return paths.join("\n");

  const commands: [string, string[]][] = [
    ["xclip", ["-selection", "clipboard", "-t", "UTF8_STRING", "-o"]],
    ["xclip", ["-selection", "clipboard", "-t", "STRING", "-o"]],
    ["xclip", ["-selection", "clipboard", "-t", "text/plain;charset=utf-8", "-o"]],
    ["xclip", ["-selection", "clipboard", "-t", "text/plain", "-o"]],
    ["xsel", ["--clipboard", "--output"]],
  ];
  for (const [cmd, args] of commands) {
    const text = await runCommand(cmd, args);
    if (text && text.length > 0) return text.toString("utf8");
  }
  return null;
}

// Text and copied file paths, so the paste key keeps working when the clipboard
// holds no image. Same order as pi's built-in paste: image first, then text.
export async function readClipboardText(): Promise<string | null> {
  if (process.platform !== "linux") return null;
  if (isWayland()) {
    const text = await readWaylandText();
    if (text !== null) return text;
  }
  if (process.env.DISPLAY) return readX11Text();
  return null;
}

export async function readClipboardImage(): Promise<ClipboardImage | null> {
  if (process.platform !== "linux") {
    throw new Error("clipboard read is Linux-only (Wayland/X11) for now");
  }
  const clipboard = await detectClipboard();
  if (!clipboard) {
    throw new Error(
      isWayland() && process.env.DISPLAY
        ? "clipboard unavailable: install wl-clipboard (Wayland) or xclip (X11)"
        : isWayland()
          ? "wl-paste not found or clipboard unavailable (need package wl-clipboard)"
          : "xclip not found or clipboard unavailable (need package xclip)",
    );
  }
  const { backend, types } = clipboard;
  const mime = MIME_PRIORITY.find((m) => types.includes(m));
  if (!mime) {
    const images = types.filter((t) => t.startsWith("image/"));
    if (images.length > 0) throw new Error(`clipboard image format not supported (${images.join(", ")})`);
    return null;
  }

  const { stdout } =
    backend === "wayland"
      ? await run("wl-paste", ["--type", mime])
      : await run("xclip", ["-selection", "clipboard", "-t", mime, "-o"]);

  if (stdout.length === 0) return null;
  return { bytes: new Uint8Array(stdout), mimeType: mime };
}
