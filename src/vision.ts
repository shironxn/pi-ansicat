import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ansicatConfigPaths } from "./config.js";

export interface VisionConfig {
  provider: string;
  model: string;
  prompt?: string;
  maxTokens?: number;
}

export function loadVisionConfig(): VisionConfig | undefined {
  // ansicat.json lives under the agent dir now; the legacy ~/.pi location is
  // still read. pi-vision.json keeps its own hardcoded path because it is
  // shared with @arhen/pi-core-vision, which reads exactly that file.
  const [current, legacy] = ansicatConfigPaths();
  for (const p of [current, legacy]) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as { vision?: VisionConfig };
      if (raw.vision?.provider && raw.vision?.model) return raw.vision;
    } catch { /* fall through */ }
  }
  try {
    const p = `${process.env.HOME ?? ""}/.pi/pi-vision.json`;
    const raw = JSON.parse(readFileSync(p, "utf8")) as VisionConfig;
    if (raw.provider && raw.model) return raw;
  } catch { /* no config */ }
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
              text: cfg.prompt ?? "Describe this image factually for a text-only assistant: subject, style, colors, layout, and any visible text verbatim (OCR). 3-8 sentences.",
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
