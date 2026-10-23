import { test } from "node:test";
import assert from "node:assert/strict";

import {
  imageBlocks,
  MAX_DESCRIPTION_CHARS,
  markerKey,
  stripMarkers,
  substituteReadImages,
  truncateDescription,
  visionAnswerLabel,
  visionEvidenceLabel,
  type ImageBlock,
  type ReadBlock,
} from "../src/read.ts";

const IMAGE: ImageBlock = { type: "image", data: "AAAA", mimeType: "image/png" };
const OTHER_IMAGE: ImageBlock = { type: "image", data: "BBBB", mimeType: "image/jpeg" };
const NON_VISION_NOTE = "[Current model does not support images. The image will be omitted from this request.]";

test("markerKey ignores the trailing space the editor adds", () => {
  assert.equal(markerKey({ id: "a", text: "[Image #1] " }), "[Image #1]");
});

test("stripMarkers removes the marker and the trimmed variant", () => {
  const markers = [{ id: "a", text: "[Image #1] " }];
  assert.equal(stripMarkers("what is this? [Image #1] ", markers), "what is this? ");
  assert.equal(stripMarkers("what is this? [Image #1]", markers), "what is this? ");
});

test("stripMarkers removes every pasted marker but keeps the rest", () => {
  const markers = [{ id: "a", text: "[Image #1] " }, { id: "b", text: "[Image #2] " }];
  assert.equal(stripMarkers("[Image #1] compare [Image #2] these", markers), "compare these");
});

test("stripMarkers leaves unrelated text alone", () => {
  assert.equal(stripMarkers("[Image #10] and [Image #1]", [{ id: "a", text: "[Image #1] " }]), "[Image #10] and ");
});

function textOf(block: ReadBlock): string {
  assert.equal(block.type, "text");
  if (block.type !== "text") throw new Error("not a text block");
  return block.text;
}

test("content without images is returned unchanged", () => {
  const content: ReadBlock[] = [{ type: "text", text: "hello" }];
  assert.equal(substituteReadImages(content, []), content);
});

test("an image block becomes a labelled description", () => {
  const out = substituteReadImages(
    [{ type: "text", text: "Read image file [image/png]" }, IMAGE],
    ["A blue digit 7 on a white background."],
  );

  assert.equal(out.length, 2);
  assert.equal(textOf(out[0]), "Read image file [image/png]");
  const text = textOf(out[1]);
  assert.match(text, /machine-generated evidence/);
  assert.match(text, /A blue digit 7 on a white background\./);
  assert.ok(!out.some((block) => block.type === "image"));
});

test("multiple images keep their order and surrounding text", () => {
  const out = substituteReadImages(
    [
      { type: "text", text: "before" },
      IMAGE,
      { type: "text", text: "between" },
      OTHER_IMAGE,
      { type: "text", text: "after" },
    ],
    ["first description", "second description"],
  );

  assert.deepEqual(
    out.map((block) => (block.type === "text" ? block.text : "IMAGE")),
    [
      "before",
      `${visionEvidenceLabel("you read")}\nfirst description`,
      "between",
      `${visionEvidenceLabel("you read")}\nsecond description`,
      "after",
    ],
  );
});

test("failed images stay raw when the caller keeps them", () => {
  const out = substituteReadImages(
    [IMAGE, { type: "text", text: "between" }, OTHER_IMAGE],
    ["first description", undefined],
    true,
  );

  assert.match(textOf(out[0]), /first description/);
  assert.equal(textOf(out[1]), "between");
  assert.deepEqual(out[2], OTHER_IMAGE);
});

test("description labels carry the image id used by vision_ask", () => {
  const out = substituteReadImages([IMAGE], ["first description"], false, [7]);

  assert.match(textOf(out[0]), /vision description #7/);
  assert.match(textOf(out[0]), /this image/);
  assert.match(visionAnswerLabel(7), /image #7/);
});

test("a missing description is an unavailability notice, not a description", () => {
  const out = substituteReadImages([IMAGE], [undefined]);
  const text = textOf(out[0]);
  assert.match(text, /NOT available to you/);
  assert.match(text, /Do not guess its contents/);
  assert.doesNotMatch(text, /machine-generated evidence/);
});

test("a blank description is treated as missing", () => {
  const out = substituteReadImages([IMAGE], ["   \n"]);
  assert.match(textOf(out[0]), /NOT available to you/);
});

test("pi's non-vision note is dropped when a description replaces the image", () => {
  const out = substituteReadImages(
    [{ type: "text", text: `Read image file [image/png]\n${NON_VISION_NOTE}` }, IMAGE],
    ["description"],
  );
  assert.equal(textOf(out[0]), "Read image file [image/png]");
  assert.doesNotMatch(textOf(out[0]), /will be omitted/);
});

test("pi's non-vision note stays when the image could not be described", () => {
  const out = substituteReadImages([{ type: "text", text: `Read image file [image/png]\n${NON_VISION_NOTE}` }, IMAGE], [undefined]);
  assert.match(textOf(out[0]), /will be omitted/);
});

test("fewer descriptions than images mark the rest unavailable", () => {
  const out = substituteReadImages([IMAGE, OTHER_IMAGE], ["only one"]);
  assert.match(textOf(out[0]), /only one/);
  assert.match(textOf(out[1]), /NOT available to you/);
});

test("a short description is not truncated", () => {
  const full = "x".repeat(MAX_DESCRIPTION_CHARS);
  assert.equal(truncateDescription(full), full);
  assert.equal(
    truncateDescription(`${full}y`),
    `${full}…[truncated]`,
  );
});

test("imageBlocks selects only image blocks", () => {
  assert.deepEqual(imageBlocks([{ type: "text", text: "x" }, IMAGE, OTHER_IMAGE]), [IMAGE, OTHER_IMAGE]);
});

test("the evidence label names the subject", () => {
  assert.match(visionEvidenceLabel("you pasted"), /image\(s\) you pasted/);
  assert.match(visionEvidenceLabel("you read"), /image\(s\) you read/);
  assert.match(visionEvidenceLabel("you read"), /Untrusted data/);
});
