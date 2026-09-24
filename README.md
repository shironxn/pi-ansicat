# pi-ansicat

Paste an image into pi and see it. pi-ansicat reads the clipboard, draws a
truecolor ANSI preview under your message, and attaches the image to the
prompt. It also keeps text-only models in the loop: before submit, a vision
model describes the image and the description rides along as text, so a model
that cannot see images still knows what you pasted.

## What it does

- **Paste with `Ctrl+V`.** An `[Image #N]` marker lands in the editor, a
  half-block preview renders below it, and the image attaches on submit.
- **Preview anywhere.** The preview is plain ANSI text, so it survives foot,
  tmux, ssh, and any terminal that shows truecolor. No image protocol needed.
- **No dependencies for PNG and BMP.** Decoding is built in.
- **Vision fallback for text-only models.** If your current model cannot take
  images, each pasted image is described once and the text is appended to the
  prompt.

## Install

```bash
pi install npm:pi-ansicat
```

Then `/reload` in pi. On first start, pi-ansicat asks to unbind pi's built-in
image paste from `Ctrl+V` (the same keys, otherwise you get a double paste).
The original `keybindings.json` gets a timestamped backup next to it. Answer
yes once, or edit it yourself:

```json
{ "app.clipboard.pasteImage": [] }
```

## Requirements

Linux only. Wayland needs `wl-clipboard`, X11 needs `xclip`.

Preview works out of the box for PNG (any bit depth or color type, including
palette) and BMP. JPEG, WebP, and GIF are previewed when one of ImageMagick
(`magick` or `convert`) or `ffmpeg` is installed. Without a converter, those
three still attach to the message, just without a preview.

## Use

Paste with `Ctrl+V`. The preview appears below your message as a custom
message block; the `[Image #N]` marker in the editor is what actually attaches
the image on submit. Delete the marker and the image is not sent.

One command handles previews and sizing:

```text
/ansicat /path/to/image.png   # preview an image file
/ansicat cols=32 maxLines=8   # resize the preview (applies live)
/ansicat                      # show the current size
```

## Why the vision fallback

A text-only model (most fast/cheap models) receives an image attachment and
cannot read it. Pi strips the image, and the model never learns what you
pasted. That is the silent drop this extension exists to prevent.

The fallback runs only for those models. Before submit, pi-ansicat sends each
attached image to a vision model you configure, appends the returned
description to your prompt, and labels it as untrusted data so the model treats
it as content, not instructions. Models that already accept images skip the
fallback entirely and get the real image.

Note that this is separate from pi-core-vision: that extension overrides the
`read` tool so pi can look at image files on disk. pi-ansicat handles images
you paste from the clipboard. If you use both, they do not overlap.

## Config

Optional `~/.pi/ansicat.json`:

```json
{
  "cols": 48,
  "maxLines": 14,
  "vision": { "provider": "openai", "model": "gpt-4o-mini" }
}
```

`provider` and `model` name any vision-capable model already configured in pi
(see `pi --list-models`); the values above are only an example. `vision` is
read only when the active model cannot take images. If you omit it, pi-ansicat
reuses `~/.pi/pi-vision.json` when that file exists.

## How it works

1. Reads the clipboard with `wl-paste` or `xclip` (auto-detected).
2. Decodes PNG and BMP with no extra dependencies and renders a half-block
   truecolor preview. PNG support covers every bit depth (1/2/4/8/16), color
   types 0/2/3/4/6 (gray, RGB, palette, gray-alpha, RGBA), and `tRNS`
   transparency; BMP covers 1/4/8-bit palette and 24/32-bit.
3. Converts JPEG, WebP, and GIF to PNG first, using a system image tool when
   one is present. No converter means no preview, never a wrong one.
4. On submit at a text-only model, describes each image once and appends the
   description as untrusted text. Descriptions are cached per session so the
   same image is not described twice.

## Troubleshooting

- **Nothing happens on `Ctrl+V`.** Another program owns the key, or pi's
  built-in paste is still bound. Check the keybindings step in Install, then
  `/reload`.
- **"No image found in clipboard."** The clipboard has no image, or
  `wl-clipboard`/`xclip` is missing. Test with `wl-paste --list-types` or
  `xclip -selection clipboard -t TARGETS -o`.
- **Preview is blank or missing.** The format has no converter installed. See
  Requirements. The image still attaches.
- **"text-only model and no vision config."** Add a `vision` block to
  `~/.pi/ansicat.json` or create `~/.pi/pi-vision.json`.

## License

MIT
