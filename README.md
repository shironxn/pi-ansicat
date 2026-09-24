# pi-ansicat

Paste clipboard images into pi with an ANSI preview that works in any
terminal. For text-only models, each image is described by a vision
model first, so nothing gets silently dropped.

## Install

```bash
pi install npm:pi-ansicat
```

Then `/reload` in pi. On first start pi-ansicat asks to unbind the built-in
image paste from `Ctrl+V` (the same keys, otherwise double paste). The
original keybindings.json gets a backup next to it. Answer yes once, or
edit it yourself:

```json
{ "app.clipboard.pasteImage": [] }
```

## Requirements

Linux only. Wayland needs `wl-clipboard`, X11 needs `xclip`.

Preview works out of the box for PNG (any bit depth or color type,
including palette) and BMP. JPEG, WebP and GIF are previewed too when one
of `ImageMagick` (`magick` or `convert`) or `ffmpeg` is installed; without
one, those three still attach to the message, just without a preview.

## Use

Paste with `Ctrl+V`. An `[Image #N]` marker goes into the editor and
a small ANSI preview renders below the message.

One command for everything:

```text
/ansicat /path/to/image.png   # preview an image file
/ansicat cols=32 maxLines=8   # resize the preview (live)
/ansicat                      # show current size
```

## Config

Optional `~/.pi/ansicat.json`:

```json
{
  "cols": 48,
  "maxLines": 14,
  "vision": { "provider": "openai", "model": "gpt-4o-mini" }
}
```

`provider` and `model` name any vision-capable model already configured in
pi (see `pi --list-models`); the values above are only an example. `vision`
is used only for text-only models. Without it, pi-ansicat reuses
`~/.pi/pi-vision.json` when present.

## How it works

1. Reads the clipboard with `wl-paste` or `xclip` (auto-detected).
2. Decodes PNG and BMP with no extra dependencies and renders a half-block
   truecolor preview. PNG support covers every bit depth (1/2/4/8/16),
   color types 0/2/3/4/6 (gray, RGB, palette, gray-alpha, RGBA), and `tRNS`
   transparency; BMP covers 1/4/8-bit palette and 24/32-bit. It is plain
   text, so foot, tmux, and ssh all show it.
3. JPEG, WebP and GIF are converted to PNG first by a system image tool
   when one is present. No converter means no preview, never a wrong one.
4. On submit at a text-only model, each image is described once via
   the vision model and the text is appended to the message. The
   description is marked as untrusted content, not instructions.

## License

MIT
