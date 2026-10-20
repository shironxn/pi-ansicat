import assert from "node:assert/strict";
import test from "node:test";

import { ImageStore } from "../src/images.ts";

test("stores images by id and returns the latest", () => {
  const store = new ImageStore();
  const first = store.add("AAAA", "image/png");
  const second = store.add("BBBB", "image/jpeg");

  assert.deepEqual(store.get(first), { id: first, data: "AAAA", mimeType: "image/png" });
  assert.deepEqual(store.latest(), { id: second, data: "BBBB", mimeType: "image/jpeg" });
});

test("evicts the oldest image when the count cap is reached", () => {
  const store = new ImageStore();
  const ids: number[] = [];
  for (let i = 0; i < 33; i++) ids.push(store.add("AAAA", "image/png"));

  assert.equal(store.get(ids[0]), undefined);
  assert.equal(store.latest()?.id, ids[32]);
});

test("clear drops every image without reusing ids", () => {
  const store = new ImageStore();
  const first = store.add("AAAA", "image/png");
  store.clear();
  const second = store.add("BBBB", "image/jpeg");

  assert.equal(store.latest()?.id, second);
  assert.notEqual(second, first);
});
