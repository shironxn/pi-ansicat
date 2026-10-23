import assert from "node:assert/strict";
import test from "node:test";

import { parseUriList, readX11Text, type ClipboardRunner } from "../src/clipboard.ts";

function fakeRunner(handler: (cmd: string, args: string[]) => Buffer | undefined): { calls: string[][]; run: ClipboardRunner } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return handler(cmd, args);
    },
  };
}

test("parses copied file URIs into plain paths", () => {
  const raw = "# copied files\r\nfile:///home/me/a.png\r\nfile:///home/me/my%20shot.png\r\n\r\n";
  assert.deepEqual(parseUriList(raw), ["/home/me/a.png", "/home/me/my shot.png"]);
});

test("ignores comments, blank lines, non-file URIs, and an empty file URI", () => {
  assert.deepEqual(parseUriList("https://example.com/x.png\r\nfile://\r\n# note\r\n\r\n"), []);
});

test("skips malformed file URIs instead of throwing", () => {
  assert.deepEqual(parseUriList("file://remote-host/etc/passwd\nfile:///ok.png"), ["/ok.png"]);
});

test("reads copied files before any text target", async () => {
  const { calls, run } = fakeRunner((_cmd, args) =>
    args.includes("text/uri-list") ? Buffer.from("file:///tmp/a.png\n") : undefined,
  );
  assert.equal(await readX11Text(run), "/tmp/a.png");
  assert.deepEqual(calls, [["xclip", "-selection", "clipboard", "-t", "text/uri-list", "-o"]]);
});

test("reads X11 text through an explicit target", async () => {
  const { calls, run } = fakeRunner((_cmd, args) =>
    args.includes("UTF8_STRING") ? Buffer.from("hello") : undefined,
  );
  assert.equal(await readX11Text(run), "hello");
  assert.deepEqual(calls.map(([cmd, ...args]) => `${cmd} ${args.join(" ")}`), [
    "xclip -selection clipboard -t text/uri-list -o",
    "xclip -selection clipboard -t UTF8_STRING -o",
  ]);
  for (const [cmd, ...args] of calls) {
    if (cmd === "xclip") assert.ok(args.includes("-t"), `xclip call without -t: ${args.join(" ")}`);
  }
});

test("falls back through text targets and finally xsel", async () => {
  const { calls, run } = fakeRunner((cmd) => (cmd === "xsel" ? Buffer.from("xsel text") : undefined));
  assert.equal(await readX11Text(run), "xsel text");
  assert.deepEqual(calls.map(([cmd, ...args]) => `${cmd} ${args.join(" ")}`), [
    "xclip -selection clipboard -t text/uri-list -o",
    "xclip -selection clipboard -t UTF8_STRING -o",
    "xclip -selection clipboard -t STRING -o",
    "xclip -selection clipboard -t text/plain;charset=utf-8 -o",
    "xclip -selection clipboard -t text/plain -o",
    "xsel --clipboard --output",
  ]);
});

test("an empty text target does not stop the fallback", async () => {
  const { run } = fakeRunner((_cmd, args) => {
    if (args.includes("UTF8_STRING")) return Buffer.alloc(0);
    if (args.includes("STRING")) return Buffer.from("fallback");
    return undefined;
  });
  assert.equal(await readX11Text(run), "fallback");
});

test("returns null when no text target works", async () => {
  const { run } = fakeRunner(() => undefined);
  assert.equal(await readX11Text(run), null);
});
