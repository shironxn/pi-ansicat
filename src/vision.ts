import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ansicatConfigPaths } from "./config.js";

export interface VisionConfig {
  provider: string;
  model: string;
  prompt?: string;
  maxTokens?: number;
}

// Identification leads, description supports — borrowed from pi-core-vision's
// task-oriented structure. Without an explicit "name it" instruction, vision
// models drift into generic visual description ("a man in a suit") and skip
// recognition entirely, even when they know the answer.
const DEFAULT_DESCRIBE_PROMPT =
  "Identify this image for a text-only assistant that must act on it. Lead with what it IS: when the " +
  "subject is recognizable — a person, fictional character, anime/manga/game/movie title, landmark, " +
  "product, brand, logo, meme, or artwork — name it (title, series, or character name) instead of " +
  "describing around it. Then compact but complete: image type (photo, screenshot, diagram, chart, UI); " +
  "ALL visible text verbatim (OCR); layout, colors, and any detail that changes meaning if omitted. " +
  "If unsure of an identification, give your best guess with a confidence note. Plain text, no preamble.";

export function loadVisionConfig(): VisionConfig | undefined {
  // Standalone: the vision model is configured only in ansicat.json's `vision`
  // block — no reading of other extensions' config files (may move or vanish).
  for (const p of ansicatConfigPaths()) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as { vision?: VisionConfig };
      if (raw.vision?.provider && raw.vision?.model) return raw.vision;
    } catch { /* next path */ }
  }
  return undefined;
}

export function modelSupportsImages(ctx: ExtensionContext): boolean {
  const input = (ctx.model as { input?: string[] } | undefined)?.input;
  return !input || input.length === 0 || input.includes("image");
}

export async function describeImage(
  base64: string,
  mimeType: string,
  ctx: ExtensionContext,
  cfg: VisionConfig,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const registry = ctx.modelRegistry;
  const model = registry.find(cfg.provider, cfg.model);
  if (!model) throw new Error(`vision model ${cfg.provider}/${cfg.model} not found in pi's registry`);
  const message = await registry.complete(
    model,
    {
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: [
            {
              type: "text",
              text: cfg.prompt ?? DEFAULT_DESCRIBE_PROMPT,
            },
            { type: "image", data: base64, mimeType },
          ],
        } as never,
      ],
      ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
    },
    { signal },
  );
  // registry.complete surfaces API failures as result metadata, not rejections:
  // an aborted/errored call arrives here with (possibly partial) content.
  // Throw so the caller renders a real failure and never caches partial text.
  if (message.stopReason === "aborted" || message.stopReason === "error") {
    throw new Error(message.errorMessage ?? `vision call ${message.stopReason}`);
  }
  const text = (message.content ?? [])
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}
