# Changelog

## 0.3.3

- The live preview now tracks the editor in real time: it renders every
  queued paste (multi-paste shows all of them, stacked), drops a paste's
  preview the moment its marker is deleted from the editor, and clears
  entirely when none remain.
- Previews **persist after submit**: sending a message marks its previews as
  sent instead of clearing them. Only deleting a paste's marker before
  submit (skipping it) removes the preview — exactly matching intent.
- `[Image #N]` numbering is session-wide now: it keeps incrementing across
  submits instead of restarting at 1, so every sent preview has a unique
  title.
- Widget placed above the editor (matching the old preview position); capped
  at the 8 most recent items (oldest sent previews drop off first).

## 0.3.2

- Docs: demo render refreshed with the current `from clipboard` label
  (retired `clipboard.png`); description/keywords tuned for npm and the
  pi.dev gallery.

## 0.3.1

- The live preview is now an editor **widget** (`ctx.ui.setWidget`, placed
  below the editor) instead of a session entry: it disappears the moment the
  paste is resolved — submit keeps the image, deleting the marker removes the
  preview with it. Skipped pastes now leave no trace at all: nothing in the
  transcript, nothing in the model context.
- `/ansicat <file>` previews remain persistent session entries (an explicit
  command is a record, still never sent to the model).

## 0.3.0

- Preview blocks are now session **entries** (`appendEntry` +
  `registerEntryRenderer`) instead of custom messages. They render exactly
  as before, but pi serializes custom messages into the LLM context as user
  messages — every paste was injecting a permanent `ansicat: [Image #1] …`
  line into the conversation, which is what made a deleted paste look "still
  there" and fed models misleading filenames. Entries never reach the model:
  deleting the marker now removes all trace of a skipped paste.
- Bumped to 0.3.0 to mark the context-behavior change.

## 0.2.9

From a second differential audit pass over 0.2.8 (all findings verified
against pi's installed source before fixing):

- `writeBindings` no longer clobbers keybindings.json when the file changed
  while the confirm dialog sat open — statuses it cannot handle are skipped
  untouched instead of rewritten with a single key.
- Vision describe failures now surface as real failures: `registry.complete`
  reports API errors/aborts as result metadata (never rejections), so a 60s
  timeout or provider error previously surfaced as "(no description
  returned)" and partial text could get cached. Also, a mistyped
  provider/model in the config now reports the resolution failure by name.
- `PI_CODING_AGENT_DIR` with a leading `~` expands the same way pi expands
  it — previously config/binding paths diverged from pi's and a literal `~`
  directory could be created.
- `/ansicat <file>` resolves format by extension first, magic-byte sniff
  second: `.jfif`, `.jpe`, and extensionless images now preview correctly
  instead of failing as "not a PNG", and genuinely unknown formats report
  "format not supported".
- Clipboard errors distinguish "format not supported" (lists the MIME) from
  "no image", and headless sessions (no Wayland/X11) get an accurate message.
- PNG filter bytes above 4 are rejected instead of decoding as Paeth
  (silently wrong pixels).
- The no-vision-config warning says the image is dropped (it always was,
  post-0.2.8) instead of "may fail to send"; the evidence label says "the
  image(s) you pasted" (they are not attached in that path).
- `tuiSafe` also strips C1 controls and unicode format characters (bidi
  overrides) from TUI-rendered names and error paths; the declined-prompt
  write no longer rewrites clamped `cols`/`maxLines` back into the user's
  config.
- Tests: 21 → 26 (inflate cap, interlace, missing PLTE, filtered scanlines
  Sub/Up, invalid filter byte).

## 0.2.8

Hardening and latency, from a three-agent audit (code, docs, security):

- ANSI preview caps rendered rows at 4096 — a 1×64M-pixel PNG that passes the
  decode guards would otherwise render billions of lines and hang or OOM pi.
- PNG decode caps the inflated pixel buffer at 256MB (16-bit RGBA at the
  64M-pixel guard previously allowed ~512MB transient allocations).
- The text-only path no longer re-sends raw image bytes: the description
  replaces the attachment (providers reject image blocks for text-only
  models, and not sending them is faster and more private).
- The vision call now times out after 60s instead of hanging the submit
  indefinitely, and large pastes are downscaled through pi's own
  `resizeImage` before the describe call — the biggest latency win for
  screenshots.
- The vision-evidence label asks the model to verify before acting on
  anything consequential, closing the over-trust side of 0.2.7's framing.
- Smaller: describe cache keyed by image hash instead of raw base64,
  atomic-write temp names randomized, keybindings re-read at write time,
  `/ansicat` filenames sanitized for TUI output, BMP core header rejected
  with a clear error, converter input magic-checked, second `Ctrl+V` during
  a paste gets feedback instead of silence.
- Docs: pi tagline + npm/license badges, documented `prompt`/`maxTokens`,
  `@path`/`~` forms, session-only resize note, Privacy section.

## 0.2.7

- Reworked the vision-description framing: the old `UNTRUSTED DATA` label
  taught main models to dismiss the description — a live test had the vision
  model correctly identify a meme face-swap, and the main model refuse to
  repeat it. The label now presents descriptions as machine-generated
  evidence to answer from (with their stated confidence) while keeping the
  hard wall against following instructions embedded in images.

## 0.2.6

- The default vision prompt now leads with identification: people, fictional
  characters, anime/manga/game/movie titles, landmarks, products, brands,
  memes, and artwork should be named outright — not described around — with a
  best-guess-plus-confidence when the model is unsure. (The 0.2.5 prompt only
  nudged public figures/brands; live tests showed generic character details
  with no recognition of the anime in question.)

## 0.2.5

- Better default vision prompt: the describe model is now asked to name
  recognizable public figures, landmarks, brands, and logos, and to cover
  what the image *is* (photo/screenshot/diagram/UI) instead of the old
  generic "subject, style, colors" phrasing — found via a live test where
  the same model named a person in one run and not another. A custom
  `prompt` in the `vision` config still overrides this.

## 0.2.4

- Clipboard pastes are now labeled `from clipboard` instead of
  `clipboard.png` — models were treating the old path-looking label as a
  real file and wasting a `read` call on ENOENT.
- `/ansicat @path/to/image` now works: a leading `@` (pi's editor
  file-reference convention) is stripped instead of surfacing as ENOENT.

## 0.2.3

- Metadata refresh: clearer description and more searchable keywords
  (visible on npm and the pi.dev package gallery).
- README: clearer config-path wording; documented the 20MB file-preview
  cap and the unsupported-format note.
- Development tooling: dropped markdownlint; `package-lock.json` synced.

## 0.2.2

- Fully standalone docs: removed the last references to other extensions from
  the README and source comments.
- `peerDependencies` now use the `"*"` range the pi packages docs prescribe
  for host-provided packages (`@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-tui`).
- Added `pi.image` (the demo render) for the pi package gallery.

## 0.2.1

- **Standalone config**: the vision model is read only from `ansicat.json`'s
  `vision` block. The optional `~/.pi/pi-vision.json` fallback (a file owned
  by another extension) was removed — installing pi-ansicat no longer touches
  or depends on any other extension.
- Hardening for untrusted image headers: PNG and BMP now reject absurd
  declared dimensions (over 64M pixels) before allocating, `inflateSync` is
  bounded by the exact expected pixel size, and truncated BMP/PNG pixel data
  fails with a clear error instead of decoding as silent black rows.
- `/ansicat <file>` now enforces the same 20MB cap as the clipboard path.
- Known-unsupported formats (`.tiff`, `.ico`, `.svg`, `.avif`, `.heic`, ...)
  report a clear "format not supported" note instead of a bare "not a PNG".
- Config follows the pi convention: `ansicat.json` and `keybindings.json`
  resolve under `PI_CODING_AGENT_DIR` (default `~/.pi/agent`); the legacy
  `~/.pi/ansicat.json` is still read.
- The keybindings backup is now identifiable as generated by this extension:
  `keybindings.json.bak-ansicat-<timestamp>`.

## 0.2.0

- PNG: full bit-depth support (1/2/4/8/16) and all color types
  (gray, RGB, palette, gray-alpha, RGBA). Palette PNGs (colorType 3,
  including `tRNS` transparency) now preview instead of being rejected.
- BMP: added 1/4/8-bit palette and 32-bit support.
- JPEG, WebP and GIF preview via an optional system converter
  (`magick`/`convert`/`ffmpeg`). Absent converter = no preview, never a
  wrong one.
- Added a decoder test suite (`npm test`), plus a `prepublishOnly` gate
  that runs typecheck and tests.

## 0.1.0

- Initial release: clipboard image paste with ANSI half-block preview,
  vision fallback for text-only models, `/ansicat` command.
