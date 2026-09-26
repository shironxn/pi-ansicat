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
//
// Two clauses are load-bearing (both measured against a text-only-model
// transcript use case): the exact-transcription rule, because models otherwise
// tidy OCR — dropping punctuation, collapsing spaces, reflowing a compiler
// error's alignment — and the output is often copied and run verbatim; and the
// "say so plainly" rule, because without it models confidently label an
// unrecognizable subject ("Smiley face icon" for a blur) instead of flagging
// doubt.
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

// Refusal detection and the retry policy live in ./refusal.ts so they can be
// unit-tested without loading the pi runtime (this module imports pi and reads
// config files).
import { interpretReply, pickReply, resolveDescription } from "./refusal.js";
export { isRefusal } from "./refusal.js";

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
        // Omitted unless set: pi then falls back to the model's own maxTokens.
        // Sending a small default would starve reasoning models, which spend
        // the cap on hidden reasoning before writing anything.
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      },
      { signal },
    );
    // registry.complete surfaces API failures as result metadata, not rejections:
    // an aborted/errored call arrives here with (possibly partial) content.
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
    // A maxTokens the user set can be too small for a reasoning model. When the
    // capped reply is cut off, retry once without the cap — the model's own
    // limit is the ceiling — and keep whichever reply is complete, or the
    // longer one if both were cut. With no user cap there is nothing to relax:
    // the reply is already at the model's limit, so it is only marked.
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
