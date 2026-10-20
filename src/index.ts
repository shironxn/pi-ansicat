import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

import { createReadToolDefinition, resizeImage, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";

import { renderHalfBlocks } from "./art.js";
import { agentDir, ansicatConfigPaths } from "./config.js";
import { readClipboardImage } from "./clipboard.js";
import { toPngForPreview } from "./convert.js";
import { decodeImage } from "./decode.js";
import { imageBlocks, substituteReadImages, truncateDescription, visionEvidenceLabel, type ReadBlock } from "./read.js";
import type { ImageMarker, PendingImage } from "./types.js";
import { describeImage, loadVisionConfig, modelSupportsImages, type VisionConfig } from "./vision.js";

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const PREVIEW_TYPE = "pi-ansicat-preview";
// A stalled provider is not failed over, so this must be generous.
const DESCRIBE_TIMEOUT_MS = 90_000;

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jfif": "image/jpeg",
  ".jpe": "image/jpeg",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const PNG_SIG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Fallback for extensions the map does not know (including none at all).
function sniffImageMime(bytes: Uint8Array): string | undefined {
  const sig = (n: number) => String.fromCharCode(...bytes.subarray(0, n));
  if (bytes.length >= 8 && PNG_SIG_BYTES.every((v, i) => bytes[i] === v)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  if (bytes.length >= 6 && (sig(6) === "GIF87a" || sig(6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && sig(4) === "RIFF" && sig(12).slice(8, 12) === "WEBP") return "image/webp";
  return undefined;
}

interface AnsicatConfig {
  cols: number;
  maxLines: number;
  keybindingPromptDeclined?: boolean;
}
const DEFAULT_CONFIG: AnsicatConfig = { cols: 48, maxLines: 14 };
let _config: AnsicatConfig = { ...DEFAULT_CONFIG };

// First readable config wins, so a corrupt current file falls back to the legacy one.
function parseConfigFile(p: string): Partial<AnsicatConfig> | null {
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as Partial<AnsicatConfig>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch { return null; }
}

function loadConfig(): AnsicatConfig {
  for (const p of ansicatConfigPaths()) {
    const raw = parseConfigFile(p);
    if (!raw) continue;
    const cols = Math.max(20, Math.min(120, Number(raw.cols) || DEFAULT_CONFIG.cols));
    const maxLines = Math.max(4, Math.min(40, Number(raw.maxLines) || DEFAULT_CONFIG.maxLines));
    return { cols, maxLines, keybindingPromptDeclined: raw.keybindingPromptDeclined === true };
  }
  return { ...DEFAULT_CONFIG };
}

// Read-merge-write keeps unrelated keys and the replace is atomic.
async function persistDeclined(): Promise<void> {
  const [p, legacy] = ansicatConfigPaths();
  let raw: Record<string, unknown> = {};
  for (const src of [p, legacy]) {
    const parsed = parseConfigFile(src);
    if (parsed) { raw = parsed as Record<string, unknown>; break; }
  }
  // Only the flag is written; cols/maxLines stay exactly as the user set them.
  const next = { ...raw, keybindingPromptDeclined: true };
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, p);
}

interface PendingImageEx extends PendingImage {
  art: string[];
  note?: string;
  label: string;
}

// Missing file means pi's default bindings (alt+v, ctrl+v) are still active.
type BindingState =
  | { status: "bound"; cfg: Record<string, unknown> }
  | { status: "unbound" }
  | { status: "stringBound" }
  | { status: "missing" }
  | { status: "unreadable" };

function readBindings(kbPath: string): BindingState {
  let text: string;
  try {
    text = readFileSync(kbPath, "utf8");
  } catch {
    return { status: "missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "unreadable" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "unreadable" };
  }
  const cfg = parsed as Record<string, unknown>;
  const bound = cfg["app.clipboard.pasteImage"];
  if (bound === undefined) return { status: "bound", cfg };
  if (typeof bound === "string") return { status: "stringBound" };
  if (Array.isArray(bound)) return bound.length > 0 ? { status: "bound", cfg } : { status: "unbound" };
  return { status: "unbound" };
}

// Re-read at write time: the confirm dialog can stay open for minutes and a
// stale snapshot would clobber edits made in between.
async function writeBindings(kbPath: string): Promise<{ created: boolean; skipped?: boolean }> {
  const state = readBindings(kbPath);
  if (state.status === "unbound") return { created: false };
  if (state.status !== "bound" && state.status !== "missing") return { created: false, skipped: true };
  const next = { ...(state.status === "bound" ? state.cfg : {}), ["app.clipboard.pasteImage"]: [] as unknown[] };
  const body = `${JSON.stringify(next, null, 2)}\n`;
  mkdirSync(dirname(kbPath), { recursive: true });
  if (state.status === "bound") copyFileSync(kbPath, `${kbPath}.bak-ansicat-${Date.now()}`);
  const tmp = `${kbPath}.tmp.${randomUUID()}`;
  writeFileSync(tmp, body);
  renameSync(tmp, kbPath);
  return { created: state.status === "missing" };
}

interface ImageQueue {
  images: PendingImageEx[];
  markers: ImageMarker[];
  nextIndex: number;
}

function createImageQueue(): ImageQueue { return { images: [], markers: [], nextIndex: 1 }; }
function markerKey(marker: ImageMarker): string { return marker.text.trim(); }

// Strip ANSI escapes, control codes, and bidi overrides from paths before TUI output.
const tuiSafe = (s: string): string => s.replace(/[\x00-\x1f\x7f-\x9f\p{Cf}]/gu, "");

// A pending paste renders above the editor; on submit it becomes a transcript
// entry, so it scrolls with the conversation. Neither enters the LLM context.
function renderPreviewWidget(ctx: ExtensionContext): void {
  if (_widgetItems.length > MAX_WIDGET_ITEMS) _widgetItems.splice(0, _widgetItems.length - MAX_WIDGET_ITEMS);
  if (_widgetItems.length === 0) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    _previewWidgetActive = false;
    return;
  }
  ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => {
    const container = new Container();
    for (const it of _widgetItems) {
      container.addChild(new Text(theme.fg("accent", it.title), 0, 0));
      container.addChild(new Spacer(1));
      if (it.art.length > 0) for (const line of it.art) container.addChild(new Text(line, 0, 0));
      else container.addChild(new Text(theme.fg("muted", it.note ?? "preview unavailable"), 0, 0));
      container.addChild(new Spacer(1));
    }
    return container;
  }, { placement: "aboveEditor" });
  _previewWidgetActive = true;
}

// Drop a preview as soon as its marker leaves the editor.
function syncPreviewWidget(): void {
  if (!_previewWidgetActive || !_ctx || !_queue) return;
  const ctx = _ctx, queue = _queue;
  const editor = ctx.ui.getEditorText();
  const before = _widgetItems.length;
  _widgetItems = _widgetItems.filter((it) => {
    const marker = queue.markers.find((m) => m.id === it.id);
    return !!marker && editor.includes(marker.text.trim());
  });
  if (_widgetItems.length !== before) renderPreviewWidget(ctx);
}

async function buildPreview(bytes: Uint8Array, mimeType: string, label: string): Promise<{ art: string[]; note?: string }> {
  try {
    let source = bytes;
    let sourceMime = mimeType;
    if (mimeType !== "image/png" && mimeType !== "image/bmp") {
      const converted = await toPngForPreview(bytes, mimeType);
      if (!converted) return { art: [], note: `${label}: preview unavailable (${mimeType} needs a converter, or the data did not match its format)` };
      source = converted;
      sourceMime = "image/png";
    }
    const img = decodeImage(source, sourceMime);
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

const WIDGET_KEY = "pi-ansicat-preview";
const MAX_WIDGET_ITEMS = 8;
interface WidgetItem { id: string; title: string; art: string[]; note?: string; }
let _widgetItems: WidgetItem[] = [];
let _previewWidgetActive = false;
let _unsubTerminalInput: (() => void) | null = null;

function queueImage(queue: ImageQueue, pending: PendingImageEx, ctx: ExtensionContext): ImageMarker {
  const id = randomUUID();
  const placeholder = `[Image #${queue.nextIndex}] `;
  pending.id = id;
  queue.images.push(pending);
  const marker: ImageMarker = { id, text: placeholder };
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
// Capped entry count; entries are small (image-hash key + description text).
const MAX_DESCRIBE_CACHE_ENTRIES = 20;

function cacheDescription(key: string, desc: string): void {
  // Drop the oldest entry when full: Map iterates in insertion order.
  if (!_describeCache.has(key) && _describeCache.size >= MAX_DESCRIBE_CACHE_ENTRIES) {
    const oldest = _describeCache.keys().next();
    if (!oldest.done) _describeCache.delete(oldest.value);
  }
  _describeCache.set(key, desc);
}

function describeKey(base64: string): string {
  return createHash("sha256").update(base64).digest("hex");
}

// Both paste and read share the session cache, so an image is described once.
async function describeCached(
  image: { data: string; mimeType: string },
  ctx: ExtensionContext,
  cfg: VisionConfig,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const key = describeKey(image.data);
  const hit = _describeCache.get(key);
  if (hit) return hit;
  // Large uploads and image tokens dominate latency; let pi shrink it first.
  const small = await resizeImage(new Uint8Array(Buffer.from(image.data, "base64")), image.mimeType, { maxWidth: 1568, maxHeight: 1568 }).catch(() => null);
  const desc = await describeImage(small?.data ?? image.data, small?.mimeType ?? image.mimeType, ctx, cfg, signal);
  if (desc) cacheDescription(key, desc);
  return desc;
}

// Honor the agent abort and still cap a stalled provider.
function describeDeadline(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(DESCRIBE_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// Replace read images with vision descriptions for text-only models. Without
// a vision config, return pi's built-in placeholder result untouched.
// When images are replaced, structuredContent is updated to match so codemode
// callers also receive text instead of the original image block.
async function readWithVisionFallback<TDetails>(
  result: AgentToolResult<TDetails>,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<TDetails>> {
  if (!ctx.model || modelSupportsImages(ctx)) return result;
  const content = result.content as ReadBlock[];
  const images = imageBlocks(content);
  if (images.length === 0) return result;
  const cfg = loadVisionConfig();
  if (!cfg) return result;
  const descriptions: (string | undefined)[] = [];
  for (const image of images) {
    if (ctx.hasUI) ctx.ui.notify(`ansicat: describing read image via ${cfg.provider}/${cfg.model}...`, "info");
    try {
      descriptions.push(await describeCached(image, ctx, cfg, describeDeadline(signal)));
    } catch (error) {
      if (signal?.aborted) throw error;
      // The reason is a user notice, never model-facing content.
      descriptions.push(undefined);
      if (ctx.hasUI) ctx.ui.notify(`ansicat: could not describe the read image (${error instanceof Error ? error.message.slice(0, 160) : String(error)})`, "warning");
    }
  }
  const replaced = substituteReadImages(content, descriptions);
  const structuredContent = replaced
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
  return { ...result, content: replaced, structuredContent };
}

async function doPaste(): Promise<void> {
  if (_pasting) { _ctx?.ui.notify("ansicat: paste already in progress", "info"); return; }
  if (!_ctx || !_queue || !_ctx.hasUI || !_pi) return;
  // Session shutdown can null the module refs while the awaits are in flight.
  const ctx = _ctx, queue = _queue;
  _pasting = true;
  try {
    const image = await readClipboardImage();
    if (!image) { ctx.ui.notify("No image found in clipboard.", "warning"); return; }
    if (image.bytes.length > MAX_FILE_SIZE_BYTES) { ctx.ui.notify(`Image too large (${(image.bytes.length / 1048576).toFixed(1)}MB > 20MB).`, "warning"); return; }
    // Not a filename: models treat path-looking labels as files to read.
    const label = "from clipboard";
    const { art, note } = await buildPreview(image.bytes, image.mimeType, label);
    const marker = queueImage(queue, { id: "", base64: Buffer.from(image.bytes).toString("base64"), mimeType: image.mimeType, art, note, label }, ctx);
    _widgetItems.push({ id: marker.id, title: `ansicat: ${marker.text.trim()} (${label})`, art, note });
    renderPreviewWidget(ctx);
    if (note && art.length === 0) ctx.ui.notify(note, "info");
  } catch (error) { ctx.ui.notify(`ansicat paste failed: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
  finally { _pasting = false; }
}

interface PreviewDetails { title?: string; art?: string[]; note?: string; }

export function registerAnsiCat(pi: ExtensionAPI): void {
  _pi = pi;
  // Registered under the built-in name, which pi lets an extension override.
  // Renderers, schema, and structuredContent stay inherited from the base.
  const baseRead = createReadToolDefinition(process.cwd());
  pi.registerTool({
    ...baseRead,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      // pi builds its own read with the user's auto-resize setting; an
      // override must not silently re-enable a resize the user turned off.
      const autoResizeImages = pi.getSettings().images?.autoResize ?? true;
      const result = await createReadToolDefinition(ctx.cwd, { autoResizeImages }).execute(toolCallId, params, signal, onUpdate, ctx);
      return readWithVisionFallback(result, ctx, signal);
    },
  });
  // An entry renders in the TUI but never enters the LLM context (a custom
  // message would be serialized as a user message).
  pi.registerEntryRenderer<PreviewDetails>(PREVIEW_TYPE, (entry, _options, theme) => {
    try {
      const details = (entry.data ?? {}) as PreviewDetails;
      const container = new Container();
      const title = typeof details.title === "string" && details.title.length > 0 ? details.title : "ansicat preview";
      container.addChild(new Text(theme.fg("accent", title), 0, 0));
      if (details.art && details.art.length > 0) {
        container.addChild(new Spacer(1));
        for (const line of details.art) container.addChild(new Text(line, 0, 0));
      } else { container.addChild(new Spacer(1)); container.addChild(new Text(theme.fg("muted", details.note ?? "[preview unavailable: image still attached]"), 0, 0)); }
      return container;
    } catch { return undefined; }
  });

  for (const shortcut of ["ctrl+v", "alt+v", "ctrl+alt+v"] as KeyId[]) { pi.registerShortcut(shortcut, { description: "Attach clipboard image with ANSI preview", handler: doPaste }); }

  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" as const };
    if (!_queue || !_queue.markers.length || !_ctx) return { action: "continue" as const };
    const ctx = _ctx, queue = _queue; // survive session_shutdown during the awaits
    const attached = queue.markers.filter((m) => event.text.includes(markerKey(m)));
    const imagesToAttach: PendingImageEx[] = [];
    for (const marker of attached) { const pending = queue.images.find((img) => img.id === marker.id); if (pending) imagesToAttach.push(pending); }
    // Read from the queue, not _widgetItems: the terminal-input sync can clear
    // that first when the editor empties on Enter.
    for (const marker of attached) {
      const img = queue.images.find((i) => i.id === marker.id);
      if (img) pi.appendEntry(PREVIEW_TYPE, { title: `ansicat: ${marker.text.trim()} (${img.label})`, art: img.art, note: img.note });
    }
    queue.images.length = 0; queue.markers.length = 0;
    if (_previewWidgetActive || _widgetItems.length) { ctx.ui.setWidget(WIDGET_KEY, undefined); _previewWidgetActive = false; }
    _widgetItems = [];
    if (imagesToAttach.length === 0) return { action: "continue" as const };
    let text = event.text;
    if (!modelSupportsImages(ctx)) {
      const cfg = loadVisionConfig();
      if (cfg) {
        // Keep failures apart from descriptions so an API error never reads
        // like evidence about the image.
        const notes: string[] = [];
        const failures: string[] = [];
        for (const img of imagesToAttach) {
          const key = describeKey(img.base64);
          const hit = _describeCache.get(key);
          if (hit) { notes.push(hit); continue; }
          ctx.ui.notify(`ansicat: describing image via ${cfg.provider}/${cfg.model}...`, "info");
          try {
            const desc = await describeCached({ data: img.base64, mimeType: img.mimeType }, ctx, cfg, AbortSignal.timeout(DESCRIBE_TIMEOUT_MS));
            if (desc) notes.push(desc); else failures.push("no description returned");
          }
          catch (err) { failures.push(err instanceof Error ? err.message.slice(0, 160) : String(err)); }
        }
        if (notes.length > 0) text = `${event.text}\n\n${visionEvidenceLabel("you pasted")}\n${notes.map((n, i) => `[image ${i + 1}] ${truncateDescription(n)}`).join("\n")}`;
        if (failures.length > 0) {
          // Say the image is unavailable instead of letting the model guess.
          const reason = failures.join("; ");
          if (notes.length === 0) {
            text = `${event.text}\n\n[ansicat: the pasted image could not be described and is NOT available to you. Do not guess its contents. Reason: ${reason}]`;
          } else {
            text += `\n[ansicat: ${failures.length} further image(s) could not be described and are NOT available to you. Reason: ${reason}]`;
          }
          ctx.ui.notify(`ansicat: image description failed (${reason})`, "warning");
        }
      } else { ctx.ui.notify("ansicat: text-only model and no vision config; image dropped (add a vision block to ansicat.json to describe it)", "warning"); }
      // Descriptions replace only ansicat's images; caller-attached images pass through.
      return { action: "transform" as const, text, images: event.images ?? [] };
    }
    return { action: "transform" as const, text, images: [...(event.images ?? []), ...imagesToAttach.map((img) => ({ type: "image" as const, data: img.base64, mimeType: img.mimeType }))] };
  });

  pi.registerCommand("ansicat", {
    description: "Clipboard ANSI preview: /ansicat [<image-path> | cols=<n> | maxLines=<n>]",
    handler: async (args: string, ctx) => {
      const source = args.trim();

      // Bare config keys (and typos like `/ansicat cols`) go to config, not ENOENT.
      const first = source.split(/\s+/)[0] ?? "";
      const [bareKey] = first.split("=");
      const looksLikeConfigKey = bareKey === "cols" || bareKey === "maxLines" || bareKey === "help";
      if (looksLikeConfigKey || source === "") {
        if (bareKey === "help") {
          ctx.ui.notify("ansicat usage: /ansicat <file.png> | /ansicat cols=<n> maxLines=<n>", "info");
          return;
        }
        // key=value adjusts the preview live; bare text shows the current size.
        for (const kv of source.split(/\s+/).filter(Boolean)) {
          const [k, v] = kv.split("=");
          const n = Number(v);
          if (!Number.isFinite(n) || n <= 0) continue;
          if (k === "cols") _config.cols = Math.min(120, Math.max(20, Math.round(n)));
          if (k === "maxLines") _config.maxLines = Math.min(40, Math.max(4, Math.round(n)));
        }
        ctx.ui.notify(`ansicat: cols=${_config.cols} maxLines=${_config.maxLines} (usage: /ansicat <file.png> | /ansicat cols=<n> maxLines=<n>)`, "info");
        return;
      }

      try {
        // A leading "@" is pi's file-reference habit; treat it as a plain path.
        const abs = resolve(ctx.cwd, source.replace(/^@/, "").replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
        const bytes = new Uint8Array(await readFile(abs));
        if (bytes.length > MAX_FILE_SIZE_BYTES) {
          ctx.ui.notify(`ansicat: file too large (${(bytes.length / 1048576).toFixed(1)}MB > 20MB)`, "error");
          return;
        }
        const name = tuiSafe(basename(abs));
        const ext = extname(abs).toLowerCase();
        // Extension first; magic bytes cover aliases and extensionless files.
        const mime = MIME_BY_EXT[ext] ?? sniffImageMime(bytes);
        if (!mime) {
          const note = `${name}: preview unavailable (${ext ? `.${ext.slice(1)} ` : ""}format not supported; png/bmp native, jpeg/webp/gif via converter)`;
          pi.appendEntry(PREVIEW_TYPE, { title: `ansicat: ${name}`, art: [], note });
          return;
        }
        const { art, note } = await buildPreview(bytes, mime, name);
        pi.appendEntry(PREVIEW_TYPE, { title: `ansicat: ${name}`, art, note });
      } catch (err) { ctx.ui.notify(`ansicat: ${tuiSafe(err instanceof Error ? err.message : String(err))}`, "error"); }
    },
  });
}

export default function (pi: ExtensionAPI): void {
  registerAnsiCat(pi);
  pi.on("session_start", async (_event, ctx) => {
    _ctx = ctx;
    _queue = createImageQueue();
    _config = loadConfig();
    // A fresh session must not inherit the previous session's live preview.
    if (_previewWidgetActive || _widgetItems.length) { ctx.ui.setWidget(WIDGET_KEY, undefined); _previewWidgetActive = false; }
    _widgetItems = [];
    if (_unsubTerminalInput) { _unsubTerminalInput(); _unsubTerminalInput = null; }
    if (ctx.hasUI) {
      _unsubTerminalInput = ctx.ui.onTerminalInput(() => {
        if (!_previewWidgetActive) return;
        setTimeout(() => syncPreviewWidget(), 0);
      });
    }
    if (!ctx.hasUI) return;

    // Ask once to unbind pi's built-in paste, which shares these keys.
    const kbPath = `${agentDir()}/keybindings.json`;
    const state = readBindings(kbPath);
    if (!_config.keybindingPromptDeclined && (state.status === "bound" || state.status === "missing" || state.status === "stringBound")) {
      const ok = await ctx.ui.confirm(
        "pi-ansicat",
        state.status === "stringBound"
          ? "pi-ansicat: app.clipboard.pasteImage uses a string binding, which cannot be auto-unbound. Edit keybindings.json manually."
          : "Ctrl+V also triggers pi's built-in image paste (double paste). Unbind the built-in in keybindings.json? (original is backed up)",
      );
      if (!ok) {
        _config.keybindingPromptDeclined = true;
        try { await persistDeclined(); }
        catch { /* non-fatal: worst case the prompt shows again next session */ }
      }
      if (ok && state.status !== "stringBound") {
        try {
          const result = await writeBindings(kbPath);
          if (result.skipped) {
            ctx.ui.notify("ansicat: keybindings.json changed while the dialog was open; not writing it", "warning");
          } else {
            ctx.ui.notify(
              result.created
                ? "ansicat: keybindings.json created with built-in paste unbound, reload to apply"
                : "ansicat: built-in paste unbound (backup kept), reload to apply",
              "info",
            );
          }
        } catch (err) {
          ctx.ui.notify(`ansicat: could not write keybindings.json (${err instanceof Error ? err.message : String(err)})`, "warning");
        }
      }
    }
  });
  pi.on("session_shutdown", () => {
    if (_previewWidgetActive) { _ctx?.ui.setWidget(WIDGET_KEY, undefined); _previewWidgetActive = false; }
    _widgetItems = [];
    if (_unsubTerminalInput) { _unsubTerminalInput(); _unsubTerminalInput = null; }
    _ctx = null; _queue = null; _pasting = false; _describeCache.clear();
  });
}
