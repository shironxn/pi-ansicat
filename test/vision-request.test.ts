import assert from "node:assert/strict";
import test from "node:test";

import { buildVisionCall } from "../src/vision-request.ts";

const IMAGE = { data: "AAAA", mimeType: "image/png" };

test("stream options carry the output cap and temperature for non-reasoning models", () => {
  const call = buildVisionCall(IMAGE, "rules", "task", { reasoning: false }, 800);

  assert.deepEqual(call.options, { maxTokens: 800, temperature: 0 });
});

test("reasoning models keep their provider temperature and an unset cap", () => {
  const call = buildVisionCall(IMAGE, "rules", "task", { reasoning: true });

  assert.deepEqual(call.options, {});
});

test("rules and task share a user message after the image", () => {
  const call = buildVisionCall(IMAGE, "rules", "task", { reasoning: false });
  const content = call.context.messages[0].content;

  assert.deepEqual(content[0], { type: "image", data: "AAAA", mimeType: "image/png" });
  assert.deepEqual(content[1], { type: "text", text: "rules\n\ntask" });
});

test("a custom prompt with no task sends the rules alone", () => {
  const call = buildVisionCall(IMAGE, "custom rules", "", { reasoning: false });

  assert.deepEqual(call.context.messages[0].content[1], { type: "text", text: "custom rules" });
});
