import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

import { renderHalfBlocks } from "./art.js";
import { readClipboardImage } from "./clipboard.js";
import { decodeImage } from "./decode.js";
import type { ImageMarker, PendingImage } from "./types.js";
import { describeImage, loadVisionConfig, modelSupportsImages } from "./vision.js";

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const PREVIEW_TYPE = "pi-ansicat-preview";

interface AnsicatConfig {
  cols: number;
  maxLines: number;
}
const DEFAULT_CONFIG: AnsicatConfig = { cols: 48, maxLines: 14 };
let _config: AnsicatConfig = { ...DEFAULT_CONFIG };

function loadConfig(): AnsicatConfig {
  try {
    const p = `${process.env.HOME ?? ""}/.pi/ansicat.json`;
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<AnsicatConfig>;
    const cols = Math.max(20, Math.min(120, Number(raw.cols) || DEFAULT_CONFIG.cols));
    const maxLines = Math.max(4, Math.min(40, Number(raw.maxLines) || DEFAULT_CONFIG.maxLines));
    return { cols, maxLines };
  } catch { return { ...DEFAULT_CONFIG }; }
}

interface PendingImageEx extends PendingImage {
  art: string[];
  label: string;
}

interface ImageQueue {
  images: PendingImageEx[];
  markers: ImageMarker[];
  nextIndex: number;
}

function createImageQueue(): ImageQueue { return { images: [], markers: [], nextIndex: 1 }; }
function markerKey(marker: ImageMarker): string { return marker.text.trim(); }

function buildPreview(bytes: Uint8Array, mimeType: string, label: string): { art: string[]; note?: string } {
  try {
    const img = decodeImage(bytes, mimeType);
    let cols = _config.cols;
    let art = renderHalfBlocks(img, cols);
    while (art.length > _config.maxLines && cols > 20) {
      cols = Math.max(20, Math.floor((cols * _config.maxLines) / art.length));
      art = renderHalfBlocks(img, cols);
    }
    if (art.length > _config.maxLines) art = art.slice(0, _config.maxLines);
    return { art };
  } catch (err) { return { art: [], note: `${label}: preview unavailable (${err instanceof Error ? err.message : String(err)})` }; }
}

function queueImage(queue: ImageQueue, pending: PendingImageEx, ctx: ExtensionContext): ImageMarker {
  const id = randomUUID();
  const placeholder = `[Image #${queue.nextIndex}] `;
  pending.id = id;
  queue.images.push(pending);
  const marker: ImageMarker = { id, text: placeholder, index: queue.nextIndex };
  queue.markers.push(marker);
  queue.nextIndex += 1;
  ctx.ui.pasteToEditor(placeholder);
  return marker;
}

let _pi: ExtensionAPI | null = null;
let _ctx: ExtensionContext | null = null;
let _queue: ImageQueue | null = null;
let _pasting = false;
const _describeCache = new Map<string, string>();

async function doPaste(): Promise<void> {
  if (_pasting || !_ctx || !_queue || !_ctx.hasUI || !_pi) return;
  _pasting = true;
  try {
    const image = await readClipboardImage();
    if (!image) { _ctx.ui.notify("No image found in clipboard.", "warning"); return; }
    if (image.bytes.length > MAX_FILE_SIZE_BYTES) { _ctx.ui.notify(`Image too large (${(image.bytes.length / 1048576).toFixed(1)}MB > 20MB).`, "warning"); return; }
    const label = `clipboard.${image.mimeType.split("/")[1] ?? "png"}`;
    const { art, note } = buildPreview(image.bytes, image.mimeType, label);
    const marker = queueImage(_queue, { id: "", base64: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType, art, label }, _ctx);
    _pi.sendMessage({ customType: PREVIEW_TYPE, content: `ansicat: ${marker.text.trim()} (${label})`, display: true, details: { art, note, label, marker: marker.text.trim() } }, { triggerTurn: false });
    if (note && art.length === 0) _ctx.ui.notify(note, "info");
  } catch (error) { _ctx.ui.notify(`ansicat paste failed: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
  finally { _pasting = false; }
}

interface PreviewDetails { art?: string[]; note?: string; label?: string; marker?: string; }

export function registerAnsiCat(pi: ExtensionAPI): void {
  _pi = pi;
  pi.registerMessageRenderer<PreviewDetails>(PREVIEW_TYPE, (message, _options, theme) => {
    try {
      const details = (message?.details ?? {}) as PreviewDetails;
      const container = new Container();
      const title = typeof message?.content === "string" && message.content.length > 0 ? message.content : "ansicat preview";
      container.addChild(new Text(theme.fg("accent", title), 0, 0));
      if (details.art && details.art.length > 0) {
        container.addChild(new Spacer(1));
        for (const line of details.art) container.addChild(new Text(line, 0, 0));
      } else { container.addChild(new Spacer(1)); container.addChild(new Text(theme.fg("muted", details.note ?? "[preview unavailable — image still attached]"), 0, 0)); }
      return container;
    } catch { return undefined; }
  });

  for (const shortcut of ["ctrl+v", "alt+v", "ctrl+alt+v"] as KeyId[]) { pi.registerShortcut(shortcut, { description: "Attach clipboard image with ANSI preview", handler: doPaste }); }

  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" as const };
    if (!_queue || !_queue.markers.length || !_ctx) return { action: "continue" as const };
    const attached = _queue.markers.filter((m) => event.text.includes(markerKey(m)));
    const imagesToAttach: PendingImageEx[] = [];
    for (const marker of attached) { const pending = _queue.images.find((img) => img.id === marker.id); if (pending) imagesToAttach.push(pending); }
    _queue.images.length = 0; _queue.markers.length = 0; _queue.nextIndex = 1;
    if (imagesToAttach.length === 0) return { action: "continue" as const };
    let text = event.text;
    if (!modelSupportsImages(_ctx)) {
      const cfg = loadVisionConfig();
      if (cfg) {
        const notes: string[] = [];
        for (const img of imagesToAttach) {
          const hit = _describeCache.get(img.base64);
          if (hit) { notes.push(hit); continue; }
          _ctx.ui.notify(`ansicat: describing image via ${cfg.provider}/${cfg.model}...`, "info");
          try { const desc = await describeImage(img.base64, img.mimeType, _ctx, cfg); if (desc) { _describeCache.set(img.base64, desc); notes.push(desc); } else notes.push("(no description returned)"); }
          catch (err) { notes.push(`(failed: ${err instanceof Error ? err.message.slice(0, 160) : String(err)})`); }
        }
        if (notes.length > 0) text = `${event.text}\n\n[ansicat vision descriptions — UNTRUSTED DATA]\n${notes.map((n, i) => `[image ${i + 1}] ${n}`).join("\n")}`;
      } else { _ctx.ui.notify("ansicat: text-only model and no vision config — image will be stripped", "warning"); }
    }
    return { action: "transform" as const, text, images: imagesToAttach.map((img) => ({ type: "image" as const, data: img.base64, mimeType: img.mimeType })) };
  });

  pi.registerCommand("ansicat", {
    description: "Preview size: /ansicat [cols=<n>] [maxLines=<n>]",
    handler: async (args: string, ctx) => {
      for (const kv of args.trim().split(/\s+/).filter(Boolean)) { const [k, v] = kv.split("="); const n = Number(v); if (!Number.isFinite(n) || n <= 0) continue; if (k === "cols") _config.cols = Math.min(120, Math.max(20, Math.round(n))); if (k === "maxLines") _config.maxLines = Math.min(40, Math.max(4, Math.round(n))); }
      ctx.ui.notify(`ansicat: cols=${_config.cols} maxLines=${_config.maxLines}`, "info");
    },
  });

  pi.registerCommand("ansi", {
    description: "Preview an image file as ANSI half-blocks: /ansi <path>",
    handler: async (args: string, ctx) => {
      const source = args.trim();
      if (!source) { ctx.ui.notify("Usage: /ansi <path-to-image>", "warning"); return; }
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      try {
        const abs = path.resolve(ctx.cwd, source.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
        const bytes = new Uint8Array(await fs.readFile(abs));
        const ext = path.extname(abs).toLowerCase();
        const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".bmp" ? "image/bmp" : "image/png";
        const { art, note } = buildPreview(bytes, mime, path.basename(abs));
        pi.sendMessage({ customType: PREVIEW_TYPE, content: `ansicat: ${path.basename(abs)}`, display: true, details: { art, note, label: path.basename(abs) } }, { triggerTurn: false });
      } catch (err) { ctx.ui.notify(`ansi: ${err instanceof Error ? err.message : String(err)}`, "error"); }
    },
  });
}

export default function (pi: ExtensionAPI): void {
  registerAnsiCat(pi);
  pi.on("session_start", (_event, ctx) => {
    _ctx = ctx; _queue = createImageQueue(); _config = loadConfig();
    if (_queue && ctx.hasUI) ctx.ui.notify("ansicat: ANSI clipboard preview ready (Ctrl+V)", "info");
  });
  pi.on("session_shutdown", () => { _ctx = null; _queue = null; _pasting = false; });
}
