import { test } from "node:test";
import assert from "node:assert/strict";

import { renderHalfBlocks } from "../src/art.ts";

test("caps render rows for extreme aspect ratios", () => {
  // A 1×100000 PNG passes the decode guards but would render 2.4M lines
  // without the row cap.
  const img = { width: 1, height: 100_000, rgba: new Uint8Array(100_000 * 4) };
  const art = renderHalfBlocks(img, 48);
  assert.ok(art.length <= 4096, `expected <= 4096 rows, got ${art.length}`);
  assert.ok(art.length > 0);
});

test("caps rows even at minimum column width", () => {
  const img = { width: 1, height: 64_000_000, rgba: new Uint8Array(4) };
  const art = renderHalfBlocks(img, 20);
  assert.ok(art.length <= 4096, `expected <= 4096 rows, got ${art.length}`);
});

test("normal images keep their computed row count", () => {
  // 400×300 → rows = 300 * (48/400) * 0.5 ≈ 18
  const img = { width: 400, height: 300, rgba: new Uint8Array(400 * 300 * 4) };
  const art = renderHalfBlocks(img, 48);
  assert.equal(art.length, 18);
});
