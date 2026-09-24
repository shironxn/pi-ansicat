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

## Use

Paste with `Ctrl+V`. An `[Image #N]` marker goes into the editor and
a small ANSI preview renders below the message.

One command for everything:

```text
/ansicat /path/to/image.png   # preview a PNG or BMP file
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

`vision` is only used for text-only models. Without it, pi-ansicat
reuses `~/.pi/pi-vision.json` when present.

## How it works

1. Reads the clipboard with `wl-paste` or `xclip` (auto-detected).
2. Decodes PNG (8-bit gray, RGB, gray-alpha, RGBA, non-interlaced)
   or 24-bit BMP with no extra dependencies and renders a
   half-block truecolor preview. It is plain text, so foot, tmux,
   and ssh all show it.
3. On submit at a text-only model, each image is described once via
   the vision model and the text is appended to the message. The
   description is marked as untrusted content, not instructions.

## License

MIT
