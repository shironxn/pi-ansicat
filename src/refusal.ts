// Detecting a vision model's refusal, kept as a pure module so it can be
// unit-tested without loading the pi runtime.
//
// Some vision models answer "I am a text-only assistant and cannot view
// images" instead of looking at the image. Refusals are non-deterministic —
// the same model describes the same image on a second call — so one retry
// with an explicit nudge usually recovers it.
//
// Two conditions, both needed: the phrase sits in the opening, and the whole
// reply is short. A refusal is one or two sentences; a real description of a
// screenshot carries OCR and layout and is long. The length bound is what
// keeps a screenshot whose own text says "cannot view" (an error dialog, say)
// from being misread as a refusal and retried — or worse, discarded as one.
const REFUSAL_HEAD =
  /(?:i|we)\b[^.\n]{0,40}?(?:cannot|can'?t|unable to)\s+(?:view|see|access|interpret|read)\b|\bi(?:'m| am)\s+(?:just\s+)?an?\s*text[- ]only|\bas a text[- ]only\s+(?:assistant|model|llm)\b|\bno image\b[^.\n]{0,30}\b(?:provided|attached|included|received)\b|\b(?:didn'?t|do not|don'?t)\s+(?:receive|get)\s+an image\b|\bcannot view images?\b|\bcan'?t view images?\b/i;

// The bare "cannot view images" pattern matches quoted text too, so it is held
// to a stricter length: a refusal built on it is one sentence, while a
// description that quotes it is a full paragraph.
const BARE_REFUSAL = /\bcannot view images?\b|\bcan'?t view images?\b/i;
const BARE_REFUSAL_MAX_CHARS = 160;
const REFUSAL_MAX_CHARS = 400;

export const REFUSAL_NUDGE =
  "You are shown an image and you can see it. Describe what the image actually shows — do not reply that " +
  "you cannot view images or that you are text-only. ";

export function isRefusal(text: string): boolean {
  if (text.length >= REFUSAL_MAX_CHARS) return false;
  const head = text.slice(0, 200);
  if (REFUSAL_HEAD.test(head) && !BARE_REFUSAL.test(head)) return true;
  return text.length < BARE_REFUSAL_MAX_CHARS && BARE_REFUSAL.test(head);
}

// Turn one provider reply into the text to hand upstream, or throw for a real
// failure. Kept pure (no pi, no network) so the whole stop-reason policy is
// unit-testable. `stopReason` mirrors pi's StopReason; the two that matter
// here are "error"/"aborted" (no usable reply) and "length" (a real reply that
// was cut off).
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
    // Keep what the model wrote — the opening is usually the identification,
    // which is the useful part — but say so, because the tail (often the last
    // lines of OCR) is missing and an unlabeled truncation reads as complete.
    return `${out}\n[ansicat: description truncated at the token limit — detail may be missing; raise maxTokens in ansicat.json]`;
  }
  return out;
}

// Run the model once; on a refusal, run once more with the nudge. Kept here,
// next to the detector, so the retry policy is unit-testable with a stub
// `run` and no network. `run` returns the model's text, or undefined for an
// empty reply (a provider-level refusal that a nudge will not fix).
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
