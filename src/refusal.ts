// Vision models sometimes reply with a refusal instead of looking at the
// image. Refusals are non-deterministic, so one nudge retry usually recovers.
// The length bound keeps a screenshot that quotes "cannot view" from being
// retried as a refusal.
const REFUSAL_HEAD =
  /(?:i|we)\b[^.\n]{0,40}?(?:cannot|can'?t|unable to)\s+(?:view|see|access|interpret|read)\b|\bi(?:'m| am)\s+(?:just\s+)?an?\s*text[- ]only|\bas a text[- ]only\s+(?:assistant|model|llm)\b|\bno image\b[^.\n]{0,30}\b(?:provided|attached|included|received)\b|\b(?:didn'?t|do not|don'?t)\s+(?:receive|get)\s+an image\b|\bcannot view images?\b|\bcan'?t view images?\b/i;

// Quoted text can match the bare phrase, so it gets a stricter length bound.
const BARE_REFUSAL = /\bcannot view images?\b|\bcan'?t view images?\b/i;
const BARE_REFUSAL_MAX_CHARS = 160;
const REFUSAL_MAX_CHARS = 400;

const REFUSAL_NUDGE =
  "You are shown an image and you can see it. Describe what the image actually shows. Do not reply that " +
  "you cannot view images or that you are text-only. ";

export function isRefusal(text: string): boolean {
  if (text.length >= REFUSAL_MAX_CHARS) return false;
  const head = text.slice(0, 200);
  if (REFUSAL_HEAD.test(head) && !BARE_REFUSAL.test(head)) return true;
  return text.length < BARE_REFUSAL_MAX_CHARS && BARE_REFUSAL.test(head);
}

// pi defaults a model's input to ["text"] when a provider declares no image
// support, so only an explicit "image" entry counts.
export function inputSupportsImages(input: readonly string[] | undefined): boolean {
  return Array.isArray(input) && input.includes("image");
}

// Turn a provider reply into text, or throw for error/aborted.
export function interpretReply(reply: {
  stopReason: string;
  errorMessage?: string;
  text: string;
}): string | undefined {
  if (reply.stopReason === "aborted" || reply.stopReason === "error") {
    throw new Error(reply.errorMessage ?? `vision call ${reply.stopReason}`);
  }
  const out = reply.text.trim();
  if (out.length === 0) return undefined;
  if (reply.stopReason === "length") {
    // Keep the useful opening but mark the cut: the missing tail often holds OCR.
    // Do not advise raising maxTokens; the cap was already relaxed or is the model's own.
    return `${out}\n[ansicat: description truncated at the model's output limit; detail may be missing]`;
  }
  return out;
}

// A complete reply beats a truncated one; between two cut replies, the longer
// one carries more OCR.
export function pickReply<T extends { stopReason: string; text: string }>(a: T, b: T): T {
  const aCut = a.stopReason === "length";
  const bCut = b.stopReason === "length";
  if (aCut && !bCut) return b;
  if (bCut && !aCut) return a;
  return b.text.trim().length > a.text.trim().length ? b : a;
}

// Retry once with the nudge when the first reply is a refusal.
export async function resolveDescription(
  run: (prompt: string) => Promise<string | undefined>,
  prompt: string,
): Promise<string | undefined> {
  const first = await run(prompt);
  if (!first) return undefined;
  if (!isRefusal(first)) return first;
  const second = await run(REFUSAL_NUDGE + prompt);
  if (second && !isRefusal(second)) return second;
  throw new Error("vision model refused to describe the image (it reported it cannot view images)");
}
