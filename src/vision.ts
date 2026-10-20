import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ansicatConfigPaths } from "./config.js";
import { inputSupportsImages, interpretReply, pickReply, resolveDescription } from "./refusal.js";

export interface VisionConfig {
  provider: string;
  model: string;
  prompt?: string;
  maxTokens?: number;
}

// Naming the subject matters: without it, vision models describe around a
// recognizable image instead of identifying it. Exact transcription matters
// because the output is often copied and run verbatim.
const DEFAULT_DESCRIBE_PROMPT =
  "Identify this image for a text-only assistant that must act on it. Lead with what it IS: when the " +
  "subject is recognizable — a person, fictional character, anime/manga/game/movie title, landmark, " +
  "product, brand, logo, meme, or artwork — name it (title, series, or character name) instead of " +
  "describing around it; if it is not clearly identifiable, say so plainly rather than inventing a label. " +
  "Then compact but complete: image type (photo, screenshot, diagram, chart, UI); transcribe ALL visible " +
  "text EXACTLY as it appears — preserve punctuation, spacing, capitalisation, and line breaks; never " +
  "tidy, reflow, translate, or correct it, because it may be copied and run verbatim (code, errors, paths, " +
  "commands, URLs); layout, colors, and any detail that changes meaning if omitted. If unsure of an " +
  "identification or a value, give your best guess with a confidence note. Plain text, no preamble.";

// The vision model comes only from ansicat.json's `vision` block.
export function loadVisionConfig(): VisionConfig | undefined {
  for (const p of ansicatConfigPaths()) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as { vision?: VisionConfig };
      if (raw.vision?.provider && raw.vision?.model) return raw.vision;
    } catch { /* next path */ }
  }
  return undefined;
}

export function modelSupportsImages(ctx: ExtensionContext): boolean {
  return inputSupportsImages((ctx.model as { input?: string[] } | undefined)?.input);
}

interface Attempt {
  stopReason: string;
  errorMessage?: string;
  text: string;
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

  const prompt = cfg.prompt ?? DEFAULT_DESCRIBE_PROMPT;

  const attempt = async (text: string, maxTokens: number | undefined): Promise<Attempt> => {
    const message = await registry.complete(
      model,
      {
        messages: [
          {
            role: "user",
            timestamp: Date.now(),
            content: [
              { type: "text", text },
              { type: "image", data: base64, mimeType },
            ],
          } as never,
        ],
        // Omitted unless set, so pi uses the model's own limit. A small
        // default would starve reasoning models.
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      },
      { signal },
    );
    // registry.complete reports API failures as metadata, not rejections.
    return {
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
      text: (message.content ?? [])
        .flatMap((c) => (c.type === "text" ? [c.text] : []))
        .join("\n"),
    };
  };

  const run = async (text: string): Promise<string | undefined> => {
    const first = await attempt(text, cfg.maxTokens);
    // A user cap can be too small for a reasoning model: retry once without
    // it when the reply was cut, and keep the better result.
    if (first.stopReason === "length" && cfg.maxTokens !== undefined) {
      const wider = await attempt(text, undefined).catch(() => undefined);
      if (wider && wider.stopReason !== "error" && wider.stopReason !== "aborted") {
        return interpretReply(pickReply(first, wider));
      }
    }
    return interpretReply(first);
  };

  return resolveDescription(run, prompt);
}
