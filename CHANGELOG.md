# Changelog

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
