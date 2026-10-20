# pi-ansicat

Paste an image into [pi](https://pi.dev) and see it in your terminal. pi-ansicat
reads the clipboard, draws a truecolor ANSI preview, and attaches the image to
the prompt.

Text-only models still get the picture. A vision model describes the image
first, and the description travels as labeled text. This works for pasted
images and for image files opened with the `read` tool.

[![npm](https://img.shields.io/npm/v/pi-ansicat)](https://www.npmjs.com/package/pi-ansicat)
[![license](https://img.shields.io/npm/l/pi-ansicat)](https://github.com/shironxn/pi-ansicat/blob/main/LICENSE)

## Features

- `Ctrl+V` pastes a clipboard image, inserts an `[Image #N]` marker, and shows
  an ANSI preview above the editor.
- On submit, the preview moves into the chat transcript and scrolls with it.
- Skip a paste by deleting its marker before submit. The image is not sent.
- PNG and BMP decode without extra dependencies.
- JPEG, WebP, and GIF preview through ImageMagick or ffmpeg when installed.
- Text-only models get a vision description, labeled as machine-generated
  evidence, for both pasted images and `read` results.
- Models with image input receive the real image, unchanged.

## Demo

![pi-ansicat: ANSI half-block preview of a clipboard paste](https://cdn.jsdelivr.net/npm/pi-ansicat/assets/preview.png)

## Install

```bash
pi install npm:pi-ansicat
```

Run `/reload`, then accept the prompt that unbinds pi's built-in image paste
from `Ctrl+V`. The original `keybindings.json` is backed up next to it. To do it
by hand:

```json
{ "app.clipboard.pasteImage": [] }
```

## Requirements

- pi 1.3.0 or newer.
- Linux. Wayland needs `wl-clipboard`, X11 needs `xclip`.
- Optional: ImageMagick (`magick` or `convert`) or `ffmpeg` for JPEG, WebP, and
  GIF previews. Without one, those formats still attach, just without a preview.

## Use

Paste with `Ctrl+V`. `Alt+V` and `Ctrl+Alt+V` also work.

The `[Image #N]` marker is what attaches the image. Delete the marker before
submit to skip that paste. Keep it to send the image, and the preview moves into
the transcript above your message.

Preview or resize outside the clipboard flow:

```text
/ansicat /path/to/image.png   preview a file (@path and ~/... work too)
/ansicat cols=32 maxLines=8   resize the preview for this session
/ansicat                      show the current size
```

File previews share the 20 MB cap. PNG, BMP, JPEG, WebP, and GIF are supported.

## Text-only models

Add a `vision` block to the config. Without one, pasted images are dropped with
a warning, and `read` keeps pi's built-in "image omitted" note.

```json
{
  "vision": { "provider": "openai", "model": "gpt-4o-mini" }
}
```

`provider` and `model` must name a vision-capable model already configured in
pi. See `pi --list-models`. The example above is only an example.

How it behaves:

- **Pasted image:** the description is appended to your prompt.
- **`read` result:** the image block is replaced by the description, so a
  text-only model can read screenshots and diagrams.
- **Image-capable model:** nothing is described. The real image is sent.
- **Refusal:** if the vision model says it cannot view images, pi-ansicat
  retries once with a nudge, then reports the image as unavailable.
- **Truncation:** if the reply hits the output limit, the text is kept and
  marked as truncated.
- **Failure:** an API error is shown to you. It is never used as the
  description. The model sees an explicit "not available" notice instead.

Descriptions are cached per session. The same image is not described twice.
They are labeled machine-generated evidence, and OCR text inside them is
treated as untrusted data.

## Config

Config lives at `~/.pi/agent/ansicat.json`. The old `~/.pi/ansicat.json` is
still read. Every key is optional:

```json
{
  "cols": 48,
  "maxLines": 14,
  "vision": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "prompt": "optional custom prompt",
    "maxTokens": 800
  }
}
```

- `cols`: preview width, clamped to 20-120.
- `maxLines`: preview height, clamped to 4-40.
- `vision.prompt`: replaces the built-in describe prompt.
- `vision.maxTokens`: caps the reply. Leave it unset unless you have a reason.
  Reasoning models spend the cap before writing anything. If a capped reply is
  cut off, pi-ansicat retries once without the cap.

## Privacy

Clipboard reads, decoding, and previews stay local. Only an image you describe
is sent to the provider named in `ansicat.json`, through pi's own auth, so
credentials never pass through this package.

A submitted preview is stored in pi's session file as text and ANSI art. The
image bytes are not written to disk. Previews never enter the model's context.

## Troubleshooting

- **`Ctrl+V` does nothing.** Another program owns the key, or pi's built-in
  paste is still bound. Check the keybindings step in Install, then `/reload`.
- **"No image found in clipboard."** The clipboard holds something that is not
  an image.
- **"ansicat paste failed: ..."** The clipboard tool is missing, no display
  server is set, or the format is unsupported. Install `wl-clipboard` or
  `xclip` and make sure an image is copied. Clipboard reads are Linux-only.
- **Preview is blank.** The format needs a converter. See Requirements. The
  image still attaches.
- **Interlaced PNG.** It attaches, but pi-ansicat does not preview it.
- **"text-only model and no vision config."** Add the `vision` block above.

## License

MIT
