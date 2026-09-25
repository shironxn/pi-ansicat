# Changelog

## 0.2.1

- Hardening for untrusted image headers: PNG and BMP now reject absurd
  declared dimensions (over 64M pixels) before allocating, `inflateSync` is
  bounded by the exact expected pixel size, and truncated BMP/PNG pixel data
  fails with a clear error instead of decoding as silent black rows.
- `/ansicat <file>` now enforces the same 20MB cap as the clipboard path.
- Known-unsupported formats (`.tiff`, `.ico`, `.svg`, `.avif`, `.heic`, ...)
  report a clear "format not supported" note instead of a bare "not a PNG".
- Config follows the pi convention: `ansicat.json` and `keybindings.json`
  resolve under `PI_CODING_AGENT_DIR` (default `~/.pi/agent`); the legacy
  `~/.pi/ansicat.json` is still read. `pi-vision.json` keeps its shared
  path for pi-core-vision compatibility.

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
