import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  descriptionCacheKey,
  descriptionCachePath,
  readCachedDescription,
  writeCachedDescription,
} from "../src/cache.ts";

function tempCache(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "ansicat-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return descriptionCachePath(dir);
}

function seed(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

test("cache keys separate image, model, prompt, and output cap", () => {
  const base = descriptionCacheKey("image", "provider", "model", "prompt");

  assert.notEqual(base, descriptionCacheKey("other", "provider", "model", "prompt"));
  assert.notEqual(base, descriptionCacheKey("image", "other", "model", "prompt"));
  assert.notEqual(base, descriptionCacheKey("image", "provider", "other", "prompt"));
  assert.notEqual(base, descriptionCacheKey("image", "provider", "model", "other"));
  assert.notEqual(base, descriptionCacheKey("image", "provider", "model", "prompt", 800));
});

test("the cache path sits under the agent directory", () => {
  assert.equal(descriptionCachePath("/agent"), "/agent/cache/ansicat-descriptions.json");
});

test("writes and reads a description under the agent cache directory", (t) => {
  const path = tempCache(t);
  const key = descriptionCacheKey("image", "provider", "model", "prompt");
  writeCachedDescription(path, key, "A blue digit 7.");

  assert.equal(readCachedDescription(path, key), "A blue digit 7.");
  assert.equal(readCachedDescription(path, "missing"), undefined);
  assert.match(readFileSync(path, "utf8"), /A blue digit 7\./);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("a write preserves entries another process added", (t) => {
  const path = tempCache(t);
  const external = descriptionCacheKey("external", "provider", "model", "prompt");
  const ours = descriptionCacheKey("ours", "provider", "model", "prompt");
  seed(path, { version: 1, entries: { [external]: { description: "external", at: 1 } } });

  writeCachedDescription(path, ours, "ours");

  assert.equal(readCachedDescription(path, external), "external");
  assert.equal(readCachedDescription(path, ours), "ours");
});

test("a corrupt file is ignored and replaced", (t) => {
  const path = tempCache(t);
  const key = descriptionCacheKey("image", "provider", "model", "prompt");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "not json");

  assert.equal(readCachedDescription(path, key), undefined);
  writeCachedDescription(path, key, "recovered");
  assert.equal(readCachedDescription(path, key), "recovered");
});

test("a wrong version and a non-object entry map are ignored", (t) => {
  const path = tempCache(t);
  const key = descriptionCacheKey("image", "provider", "model", "prompt");

  seed(path, { version: 0, entries: { [key]: { description: "old", at: 1 } } });
  assert.equal(readCachedDescription(path, key), undefined);

  seed(path, { version: 1, entries: [] });
  assert.equal(readCachedDescription(path, key), undefined);
});

test("invalid entries are dropped without blocking writes", (t) => {
  const path = tempCache(t);
  const good = descriptionCacheKey("good", "provider", "model", "prompt");
  const bad = descriptionCacheKey("bad", "provider", "model", "prompt");
  seed(path, { version: 1, entries: { [bad]: null, [good]: { description: 7, at: "x" } } });

  assert.equal(readCachedDescription(path, good), undefined);
  writeCachedDescription(path, good, "recovered");
  assert.equal(readCachedDescription(path, good), "recovered");
});

test("the oldest entry is evicted past the 200 entry cap", (t) => {
  const path = tempCache(t);
  const keys = Array.from({ length: 201 }, (_, index) => descriptionCacheKey(`image-${index}`, "provider", "model", "prompt"));

  for (const [index, key] of keys.entries()) writeCachedDescription(path, key, `description ${index}`);

  assert.equal(readCachedDescription(path, keys[0]), undefined);
  assert.equal(readCachedDescription(path, keys[1]), "description 1");
  assert.equal(readCachedDescription(path, keys[200]), "description 200");
});
