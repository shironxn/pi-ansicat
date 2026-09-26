import { test } from "node:test";
import assert from "node:assert/strict";

import { isRefusal, interpretReply, pickReply, resolveDescription } from "../src/refusal.ts";

// Vision models sometimes answer with a refusal instead of a description.
// These are the exact phrasings observed from real models on openai.
const REFUSALS = [
  "I am a text-only assistant and cannot view images.",
  "I cannot see the image provided.",
  "I'm unable to view images.",
  "No image was provided in your message.",
  "As a text-only model, I can't interpret images.",
  "I didn't receive an image.",
  "Still cannot view images.",
  "I cannot view images.",
];

// A description of a screenshot, including one whose OCR text happens to
// contain refusal-looking words. Length is the discriminator: a real
// description carries OCR and layout.
const DESCRIPTIONS = [
  "Rust compiler error dialog. Build Failed error[E0308]: mismatched types",
  "Invoice #A-4471 TOTAL $77.12",
  "Screenshot of a dialog whose message reads: cannot view images. " +
    "It has a red header bar, a dark grey body, and a blue Rebuild button in " +
    "the lower right; the monospaced text spans eight lines and ends with a " +
    "note to run cargo build after fixing the type mismatch.",
  "",
];

test("refusals are detected", () => {
  for (const text of REFUSALS) assert.equal(isRefusal(text), true, text);
});

test("descriptions are not mistaken for refusals", () => {
  for (const text of DESCRIPTIONS) assert.equal(isRefusal(text), false, text);
});

// A long reply that merely quotes a refusal phrase is a description: the
// length bound is what keeps a screenshot's own text from being read as one.
test("length bound protects long descriptions", () => {
  const long = "I cannot view images. " + "Detail. ".repeat(60);
  assert.equal(isRefusal(long), false);
});

test("retry recovers a non-deterministic refusal", async () => {
  const calls: string[] = [];
  const run = async (prompt: string) => {
    calls.push(prompt);
    return calls.length === 1 ? "I cannot view images." : "A red square on a white background.";
  };
  const out = await resolveDescription(run, "PROMPT");
  assert.equal(out, "A red square on a white background.");
  assert.equal(calls.length, 2);
  assert.ok(calls[1]?.startsWith("You are shown an image"), "second call carries the nudge");
});

test("a second refusal throws instead of returning the refusal as a description", async () => {
  const run = async () => "I am a text-only assistant, I cannot view images.";
  await assert.rejects(() => resolveDescription(run, "PROMPT"), /refused/);
});

test("a normal first answer is not retried", async () => {
  let calls = 0;
  const run = async () => { calls++; return "A screenshot of a terminal."; };
  const out = await resolveDescription(run, "PROMPT");
  assert.equal(out, "A screenshot of a terminal.");
  assert.equal(calls, 1);
});

// An empty reply is a provider-level failure, not a refusal: a nudge will not
// fix it, so it must not trigger a second call.
test("an empty reply is returned as undefined without a retry", async () => {
  let calls = 0;
  const run = async () => { calls++; return undefined; };
  const out = await resolveDescription(run, "PROMPT");
  assert.equal(out, undefined);
  assert.equal(calls, 1);
});

test("a normal reply passes through unchanged", () => {
  const out = interpretReply({ stopReason: "stop", text: "  A red square.  " });
  assert.equal(out, "A red square.");
});

test("an empty reply is undefined", () => {
  assert.equal(interpretReply({ stopReason: "stop", text: "   " }), undefined);
});

// A truncated reply keeps its text (the opening is usually the identification)
// but carries a marker, because an unlabeled cut reads as a complete answer.
test("a truncated reply is kept and marked", () => {
  const out = interpretReply({ stopReason: "length", text: "Rust error dialog. error[E0308]" });
  assert.ok(out?.startsWith("Rust error dialog."));
  assert.match(out ?? "", /truncated at the model's output limit/);
});

test("an errored reply throws with its message", () => {
  assert.throws(
    () => interpretReply({ stopReason: "error", errorMessage: "429 quota reached", text: "" }),
    /429 quota reached/,
  );
});

test("an aborted reply throws", () => {
  assert.throws(() => interpretReply({ stopReason: "aborted", text: "" }), /aborted/);
});

// The self-heal retry (vision.ts): when a user cap cut the reply off, a wider
// retry is preferred — a complete answer beats a truncated one.
test("a complete retry beats a truncated first reply", () => {
  const cut = { stopReason: "length", text: "Rust error. error[E0308]" };
  const full = { stopReason: "stop", text: "Rust error. error[E0308] mismatched types" };
  assert.equal(pickReply(cut, full), full);
  assert.equal(pickReply(full, cut), full);
});

// Two cut replies: the longer one carries more OCR.
test("the longer of two truncated replies wins", () => {
  const a = { stopReason: "length", text: "short" };
  const b = { stopReason: "length", text: "a much longer truncated reply with more OCR" };
  assert.equal(pickReply(a, b), b);
  assert.equal(pickReply(b, a), b);
});

test("two complete replies: the longer wins", () => {
  const a = { stopReason: "stop", text: "A red square." };
  const b = { stopReason: "stop", text: "A red square on a white background, top-left." };
  assert.equal(pickReply(a, b), b);
});

// The truncation marker no longer tells the user to raise maxTokens: by the
// time it is emitted the cap was the model's own, or a wider retry also cut.
test("the truncation marker does not advise raising maxTokens", () => {
  const out = interpretReply({ stopReason: "length", text: "Rust error dialog." });
  assert.match(out ?? "", /truncated at the model's output limit/);
  assert.doesNotMatch(out ?? "", /raise maxTokens/);
});
