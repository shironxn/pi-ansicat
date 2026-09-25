import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ansicatConfigPaths } from "./config.js";

export interface VisionConfig {
  provider: string;
  model: string;
  prompt?: string;
  maxTokens?: number;
}

// Structure borrowed from pi-core-vision's task-oriented prompt, extended for
// pasted photos: without an explicit "name it" instruction, vision models skip
// identifying public figures/brands and return a generic visual description.
const DEFAULT_DESCRIBE_PROMPT =
  "Describe this image as text for a text-only assistant that must act on it. Compact but complete: " +
  "what the image is (photo, screenshot, diagram, chart, UI, meme); the main subject — if a recognizable " +
  "public figure, landmark, brand, or logo appears, name it; ALL visible text verbatim (OCR); layout, " +
  "colors, and any detail that changes meaning if omitted. Plain text, no preamble.";

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
): Promise<string | undefined> {
  const registry = ctx.modelRegistry;
  const model = registry.find(cfg.provider, cfg.model);
  if (!model) return undefined;
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
  );
  const text = (message.content ?? [])
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("\n")
    .trim();
  return text.length > 0 ? text : undefined;
}
