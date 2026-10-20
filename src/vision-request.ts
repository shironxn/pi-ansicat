import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type VisionContext = Parameters<ExtensionContext["modelRegistry"]["complete"]>[1];
type VisionOptions = NonNullable<Parameters<ExtensionContext["modelRegistry"]["complete"]>[2]>;

export interface VisionImage {
  data: string;
  mimeType: string;
}

export type VisionContent =
  | { type: "image"; data: string; mimeType: string }
  | { type: "text"; text: string };

export interface VisionCall {
  context: VisionContext;
  options: VisionOptions;
}

// Rules travel in the user message: the 9router OpenAI-compatible combo path
// does not apply Context.systemPrompt reliably, and without the rules the
// model falls back to generic analysis and invents values. A custom prompt
// carries its own task, so only the default gets the short instruction.
export function buildVisionCall(
  image: VisionImage,
  rules: string,
  task: string,
  model: { reasoning: boolean },
  maxTokens?: number,
): VisionCall {
  return {
    context: {
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: [
            { type: "image", data: image.data, mimeType: image.mimeType },
            { type: "text", text: task.length > 0 ? `${rules}\n\n${task}` : rules },
          ],
        },
      ],
    },
    options: {
      // OCR wants determinism. Reasoning models often reject a non-default
      // temperature, so leave theirs untouched.
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(model.reasoning ? {} : { temperature: 0 }),
    },
  };
}
