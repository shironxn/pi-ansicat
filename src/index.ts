import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

import { createReadToolDefinition, defineTool, resizeImage, type AgentToolResult, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { renderHalfBlocks } from "./art.js";
import { descriptionCacheKey, descriptionCachePath, readCachedDescription, writeCachedDescription } from "./cache.js";
import { agentDir, ansicatConfigPaths } from "./config.js";
import { readClipboardImage, readClipboardText } from "./clipboard.js";
import { toPngForPreview } from "./convert.js";
import { decodeImage, sniffImageMime } from "./decode.js";
import { ImageStore } from "./images.js";
import { imageBlocks, markerKey, stripMarkers, substituteReadImages, truncateDescription, visionAnswerLabel, visionEvidenceLabel, type ReadBlock } from "./read.js";
import type { ClipboardImage, ImageMarker, PendingImage } from "./types.js";
import { isTruncatedReply } from "./refusal.js";
import { describeImage, describePrompt, loadVisionConfig, modelSupportsImages, type VisionConfig } from "./vision.js";

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

interface AnsicatConfig {
  cols: number;
  maxLines: number;
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
    return { cols, maxLines };
  }
  return { ...DEFAULT_CONFIG };
}

interface PendingImageEx extends PendingImage {
  art: string[];
  note?: string;
  label: string;
}

interface ImageQueue {
  images: PendingImageEx[];
  markers: ImageMarker[];
  nextIndex: number;
}

function createImageQueue(): ImageQueue { return { images: [], markers: [], nextIndex: 1 }; }

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

// Drop previews (and their image data) as soon as their marker leaves the editor.
function pruneQueue(queue: ImageQueue, editor: string): void {
  const live = queue.markers.filter((m) => editor.includes(markerKey(m)));
  if (live.length === queue.markers.length) return;
  queue.markers = live;
  const ids = new Set(live.map((m) => m.id));
  queue.images = queue.images.filter((img) => ids.has(img.id));
}

// Drop a preview as soon as its marker leaves the editor.
function syncPreviewWidget(): void {
  if (!_previewWidgetActive || !_ctx || !_queue) return;
  const ctx = _ctx, queue = _queue;
  const editor = ctx.ui.getEditorText();
  pruneQueue(queue, editor);
  const before = _widgetItems.length;
  const liveIds = new Set(queue.markers.map((m) => m.id));
  _widgetItems = _widgetItems.filter((it) => liveIds.has(it.id));
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
// Base64 chars are ASCII, so this is close to the memory held by pending pastes.
const MAX_PENDING_BASE64_BYTES = 64 * 1024 * 1024;
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
const _images = new ImageStore();
// Capped entry count; entries are small (composite key + description text).
const MAX_DESCRIBE_CACHE_ENTRIES = 32;

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

function descriptionKey(cfg: VisionConfig, base64: string): string {
  return descriptionCacheKey(describeKey(base64), cfg.provider, cfg.model, describePrompt(cfg), cfg.maxTokens);
}

function cachedDescription(cfg: VisionConfig, key: string): string | undefined {
  const hit = _describeCache.get(key);
  if (hit) return hit;
  if (cfg.cache !== "disk") return undefined;
  const disk = readCachedDescription(descriptionCachePath(agentDir()), key);
  if (!disk || isTruncatedReply(disk)) return undefined;
  cacheDescription(key, disk);
  return disk;
}

async function describeResized(
  image: { data: string; mimeType: string },
  ctx: ExtensionContext,
  cfg: VisionConfig,
  signal?: AbortSignal,
  options?: { question?: string },
): Promise<string | undefined> {
  // Large uploads and image tokens dominate latency; let pi shrink it first.
  const small = await resizeImage(new Uint8Array(Buffer.from(image.data, "base64")), image.mimeType, { maxWidth: 1568, maxHeight: 1568 }).catch(() => null);
  return describeImage(small?.data ?? image.data, small?.mimeType ?? image.mimeType, ctx, cfg, signal, options);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 160);
}

function visionAskError(text: string): AgentToolResult<Record<string, never>> {
  return { content: [{ type: "text", text: `[ansicat: ${text}]` }], details: {}, isError: true };
}

// Both paste and read share the session cache, so an image is described once.
// Truncated replies are usable but not cached: the next attempt can do better.
async function describeUncached(
  image: { data: string; mimeType: string },
  ctx: ExtensionContext,
  cfg: VisionConfig,
  key: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const desc = await describeResized(image, ctx, cfg, signal);
  if (desc && !isTruncatedReply(desc)) {
    cacheDescription(key, desc);
    if (cfg.cache === "disk") {
      try { writeCachedDescription(descriptionCachePath(agentDir()), key, desc); } catch { /* cache is best effort */ }
    }
  }
  return desc;
}

async function describeCached(
  image: { data: string; mimeType: string },
  ctx: ExtensionContext,
  cfg: VisionConfig,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const key = descriptionKey(cfg, image.data);
  return cachedDescription(cfg, key) ?? describeUncached(image, ctx, cfg, key, signal);
}

// Honor the agent abort and still cap a stalled provider.
function describeDeadline(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(DESCRIBE_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

// Describe read images with the configured vision model. Without a vision
// config, leave the result untouched: image-capable models get the raw image
// and text-only models keep pi's placeholder note. If describe fails on a
// vision-capable main model, failed images stay raw while successful
// descriptions still replace theirs.
async function readWithVisionFallback<TDetails>(
  result: AgentToolResult<TDetails>,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<TDetails>> {
  if (!ctx.model) return result;
  const content = result.content as ReadBlock[];
  const images = imageBlocks(content);
  if (images.length === 0) return result;
  const cfg = loadVisionConfig();
  if (!cfg) return result;
  const descriptions: (string | undefined)[] = [];
  const ids: number[] = [];
  let failed = false;
  for (const image of images) {
    ids.push(_images.add(image.data, image.mimeType));
    if (ctx.hasUI) ctx.ui.notify(`ansicat: describing read image via ${cfg.provider}/${cfg.model}...`, "info");
    try {
      const description = await describeCached(image, ctx, cfg, describeDeadline(signal));
      descriptions.push(description);
      if (!description) {
        failed = true;
        if (ctx.hasUI) ctx.ui.notify(`ansicat: vision describe failed via ${cfg.provider}/${cfg.model}: model returned an empty reply`, "warning");
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      // The reason is a user notice, never model-facing content.
      descriptions.push(undefined);
      failed = true;
      if (ctx.hasUI) ctx.ui.notify(`ansicat: vision describe failed via ${cfg.provider}/${cfg.model}: ${errorText(error)}`, "warning");
    }
  }
  const keepFailed = failed && modelSupportsImages(ctx);
  if (keepFailed && ctx.hasUI) ctx.ui.notify("ansicat: keeping the original image for descriptions that failed", "info");
  const replaced = substituteReadImages(content, descriptions, keepFailed, ids);
  if (replaced.some((block) => block.type === "image")) return { ...result, content: replaced };
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
    pruneQueue(queue, ctx.ui.getEditorText());
    let image: ClipboardImage | null = null;
    let failure: string | undefined;
    try { image = await readClipboardImage(); }
    catch (error) { failure = error instanceof Error ? error.message : String(error); }
    if (!image) {
      // The key also covers pi's built-in paste, so keep text and copied files working.
      const text = await readClipboardText().catch(() => null);
      if (text) { ctx.ui.pasteToEditor(text); return; }
      ctx.ui.notify(failure ? `ansicat paste failed: ${failure}` : "No image or text found in clipboard.", "warning");
      return;
    }
    if (image.bytes.length > MAX_FILE_SIZE_BYTES) { ctx.ui.notify(`Image too large (${(image.bytes.length / 1048576).toFixed(1)}MB > 20MB).`, "warning"); return; }
    const base64 = Buffer.from(image.bytes).toString("base64");
    const pendingBytes = queue.images.reduce((sum, img) => sum + img.base64.length, 0);
    if (pendingBytes + base64.length > MAX_PENDING_BASE64_BYTES) {
      ctx.ui.notify(`ansicat: pending previews would exceed ${MAX_PENDING_BASE64_BYTES / 1048576} MB; submit them or delete a marker first.`, "warning");
      return;
    }
    // Not a filename: models treat path-looking labels as files to read.
    const label = "from clipboard";
    const { art, note } = await buildPreview(image.bytes, image.mimeType, label);
    const marker = queueImage(queue, { id: "", base64, mimeType: image.mimeType, art, note, label }, ctx);
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
  // Renderers and schema stay inherited from the base; execute replaces content.
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
  if (loadVisionConfig()) {
    pi.registerTool(defineTool({
      name: "vision_ask",
      label: "Vision Ask",
      description:
        "Ask a specific question about an image already described in this session. Use it for exact error text, a chart value, or a UI detail the description missed. Pass the full number after `#` from the label (for example `5704357`), or omit it for the most recent image.",
      promptSnippet: "Ask a targeted question about an image described earlier in this session",
      parameters: Type.Object({
        question: Type.String({ description: "Specific question to answer from the image." }),
        image: Type.Optional(
          Type.Integer({ minimum: 1, description: "Image number from an ansicat description label. Defaults to the most recent image." }),
        ),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const question = params.question.trim();
        if (!question) return visionAskError("vision_ask needs a non-empty question");
        const cfg = loadVisionConfig();
        if (!cfg) return visionAskError("vision_ask needs a vision block in ansicat.json");
        const image = params.image === undefined ? _images.latest() : _images.get(params.image);
        if (!image) {
          return visionAskError(
            params.image === undefined
              ? "no image is available in this session; paste or read one first"
              : `image #${params.image} is not available in this session`,
          );
        }
        if (ctx.hasUI) ctx.ui.notify(`ansicat: asking vision via ${cfg.provider}/${cfg.model}...`, "info");
        try {
          const answer = await describeResized(image, ctx, cfg, describeDeadline(signal), { question });
          if (!answer) return visionAskError("vision model returned an empty reply");
          return {
            content: [{ type: "text" as const, text: `${visionAnswerLabel(image.id)}\n${truncateDescription(answer)}` }],
            details: {},
          };
        } catch (err) {
          if (signal?.aborted) throw err;
          return visionAskError(`vision ask failed via ${cfg.provider}/${cfg.model}: ${errorText(err)}`);
        }
      },
    }));
  }
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

  // Clipboard reads are Linux-only; elsewhere the built-in paste keeps these keys.
  if (process.platform === "linux") {
    for (const shortcut of ["ctrl+v", "alt+v", "ctrl+alt+v"] as KeyId[]) { pi.registerShortcut(shortcut, { description: "Attach clipboard image with ANSI preview", handler: doPaste }); }
  }

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
    const cfg = loadVisionConfig();
    if (cfg) {
      // The marker is editor-only; descriptions carry their own #N label.
      const base = stripMarkers(event.text, attached).trim();
      const withBase = (body: string) => (base.length > 0 ? `${base}\n\n${body}` : body);
      let text = base;
      // An API error must never read like evidence about the image.
      const notes: { id: number; text: string }[] = [];
      const failures: string[] = [];
      const failedImages: PendingImageEx[] = [];
      for (const img of imagesToAttach) {
        const id = _images.add(img.base64, img.mimeType);
        const key = descriptionKey(cfg, img.base64);
        const hit = cachedDescription(cfg, key);
        if (hit) { notes.push({ id, text: hit }); continue; }
        ctx.ui.notify(`ansicat: describing image via ${cfg.provider}/${cfg.model}...`, "info");
        try {
          const desc = await describeUncached({ data: img.base64, mimeType: img.mimeType }, ctx, cfg, key, describeDeadline(ctx.signal));
          if (desc) notes.push({ id, text: desc });
          else { failures.push("model returned an empty reply"); failedImages.push(img); }
        }
        catch (err) {
          if (ctx.signal?.aborted) throw err;
          failures.push(errorText(err)); failedImages.push(img);
        }
      }
      if (notes.length > 0) text = withBase(`${visionEvidenceLabel("you pasted")}\n${notes.map((n) => `[image #${n.id}] ${truncateDescription(n.text)}`).join("\n")}`);
      const supportsImages = modelSupportsImages(ctx);
      const fallbackImages = supportsImages ? failedImages.map((img) => ({ type: "image" as const, data: img.base64, mimeType: img.mimeType })) : [];
      if (failures.length > 0) {
        const reason = failures.join("; ");
        if (supportsImages) {
          ctx.ui.notify(`ansicat: vision describe failed via ${cfg.provider}/${cfg.model}: ${reason}; sending the original image`, "warning");
        } else {
          // Say the image is unavailable instead of letting the model guess.
          if (notes.length === 0) {
            text = withBase(`[ansicat: the pasted image could not be described and is NOT available to you. Do not guess its contents. Reason: ${reason}]`);
          } else {
            text += `\n[ansicat: ${failures.length} further image(s) could not be described and are NOT available to you. Reason: ${reason}]`;
          }
          ctx.ui.notify(`ansicat: vision describe failed via ${cfg.provider}/${cfg.model}: ${reason}`, "warning");
        }
      }
      // Descriptions replace only ansicat's images; caller-attached images pass through.
      return { action: "transform" as const, text, images: [...(event.images ?? []), ...fallbackImages] };
    }
    if (!modelSupportsImages(ctx)) {
      ctx.ui.notify("ansicat: text-only model and no vision config; image dropped (add a vision block to ansicat.json to describe it)", "warning");
      // Do not leave a marker pointing at an image the model will not receive.
      const stripped = stripMarkers(event.text, attached).trim();
      const dropped = "[ansicat: pasted image(s) dropped because the current model does not support images and no vision config is set. Do not guess their contents.]";
      return { action: "transform" as const, text: stripped.length > 0 ? `${stripped}\n\n${dropped}` : dropped, images: event.images ?? [] };
    }
    return { action: "transform" as const, text: event.text, images: [...(event.images ?? []), ...imagesToAttach.map((img) => ({ type: "image" as const, data: img.base64, mimeType: img.mimeType }))] };
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
        const info = statSync(abs);
        if (!info.isFile()) {
          ctx.ui.notify(`ansicat: ${tuiSafe(basename(abs))}: not a regular file`, "error");
          return;
        }
        if (info.size > MAX_FILE_SIZE_BYTES) {
          ctx.ui.notify(`ansicat: file too large (${(info.size / 1048576).toFixed(1)}MB > 20MB)`, "error");
          return;
        }
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
    _images.clear();
    _describeCache.clear();
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
  });
  pi.on("session_shutdown", () => {
    if (_previewWidgetActive) { _ctx?.ui.setWidget(WIDGET_KEY, undefined); _previewWidgetActive = false; }
    _widgetItems = [];
    if (_unsubTerminalInput) { _unsubTerminalInput(); _unsubTerminalInput = null; }
    _ctx = null; _queue = null; _pasting = false; _describeCache.clear(); _images.clear();
  });
}
