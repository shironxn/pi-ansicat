import assert from "node:assert/strict";
import test from "node:test";

import { normalizeVisionSettings } from "../src/config.ts";

test("keeps the documented vision settings", () => {
  assert.deepEqual(
    normalizeVisionSettings({ provider: "openai", model: "gpt-4o-mini", prompt: "custom", maxTokens: 800, cache: "disk" }),
    { provider: "openai", model: "gpt-4o-mini", prompt: "custom", maxTokens: 800, cache: "disk" },
  );
});

test("drops a non-string prompt instead of throwing later", () => {
  assert.deepEqual(normalizeVisionSettings({ provider: "p", model: "m", prompt: 123 }), { provider: "p", model: "m" });
});

test("drops an invalid output cap and an unknown cache mode", () => {
  assert.deepEqual(normalizeVisionSettings({ provider: "p", model: "m", maxTokens: "800", cache: "disk-ish" }), {
    provider: "p",
    model: "m",
  });
  assert.deepEqual(normalizeVisionSettings({ provider: "p", model: "m", maxTokens: 0 }), { provider: "p", model: "m" });
});

test("trims provider and model and requires both", () => {
  assert.deepEqual(normalizeVisionSettings({ provider: " openai ", model: " gpt-4o-mini " }), {
    provider: "openai",
    model: "gpt-4o-mini",
  });
  assert.equal(normalizeVisionSettings({ model: "m" }), undefined);
  assert.equal(normalizeVisionSettings({ provider: "p" }), undefined);
  assert.equal(normalizeVisionSettings({ provider: " ", model: "m" }), undefined);
});

test("rejects non-object vision blocks", () => {
  assert.equal(normalizeVisionSettings(undefined), undefined);
  assert.equal(normalizeVisionSettings(null), undefined);
  assert.equal(normalizeVisionSettings("openai"), undefined);
  assert.equal(normalizeVisionSettings([]), undefined);
});
