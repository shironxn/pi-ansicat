# pi-ansicat

Paste images with **ANSI half-block preview** and **vision fallback**  
for text-only models.

Inline image preview for terminals without kitty/iTerm2 protocol
(foot, st, tmux, SSH).

## Why

Most extensions require kitty/iTerm2 graphics protocol. Terminals like
`foot` show `[Image #N]` markers only — worse, text-only models strip
images silently on submit.

`pi-ansicat` fixes both:

1. **Immediate ANSI preview** — colorful half-block (`▀`) via plain terminal
   codes
2. **Vision fallback** — pre-describes images via vision model, preventing
   silent loss

## Install

### Via local path (dev)

```bash
pi install path:./workspace/projects/pi-ansicat
```

Then `/reload` in Pi.

### Via npm (after publish)

```bash
pi install npm:pi-ansicat
```

**Note:** Conflicts with built-in paste on `Ctrl+V`. Clear keybinding in
`~/.pi/agent/keybindings.json`:

```json
{ "app.clipboard.pasteImage": [] }
```

## Requirements

Linux only:

- **Wayland** → `wl-paste` (`sudo pacman -S wl-clipboard`)
- **X11** → `xclip` (`sudo pacman -S xclip`)

Auto-detects via `WAYLAND_DISPLAY` or `DISPLAY` vars.

## Usage

### Paste with preview

```text
Ctrl+V
```

Result:

- **[Image #N]** placeholder at cursor
- **ANSI half-block preview** below message (48×14 default)  
  Preview stays visible until submit — perfect for confirming what attached!

### Preview any file

```text
/ansi /path/to/image.png
```

Same ANSI preview for screenshot inspection, diagram review, etc.

### Adjust size live

```text
/ansicat cols=32 maxLines=8
```

Quick experimentation without config changes.

### Configure persistently

Create `~/.pi/ansicat.json`:

```json
{
  "cols": 48,
  "maxLines": 14,
  "vision": {
    "provider": "openai",
    "model": "gpt-4o-mini"
  }
}
```

| Field                   | Description                                    | Default                 |
|------------------------|------------------------------------------------|-------------------------|
| `cols`                 | Preview width (cells)                          | 48                      |
| `maxLines`             | Max preview height                             | 14                      |
| `vision.provider`      | Vision provider from registry                  | Fallback to pi-vision   |
| `vision.model`         | Model ID (needs `"input": ["text", "image"]`)  | N/A                     |

**Important:** Vision model used **only** for text-only models. Falls back
to `~/.pi/pi-vision.json` if missing.

## How it works

### 1. Clipboard read (secure)

- Uses `execFile` (not shell) → safe from injection
- Auto-detects Wayland (`wl-paste`) or X11 (`xclip`)
- Timeout protection (5s) + buffer caps (50MB clipboard, 20MB paste)

### 2. Instant preview render

```typescript
// Decode PNG/BMP via pure zlib
const img = decodePng(bytes);

// Render half-block with truecolor
for (y; y < rows; y++) {
  const topColor = px(x, y);      // foreground
  const botColor = px(x, y+1);    // background  
  line += `\x1b[38;2;${top};48;2;${bot}m▀`;
}
```

Half-block (`U+2580`) gives two vertical pixels per cell → near-full-res
preview in plain text mode.

### 3. Text-only safety net

When submitting at a text-only model (declared `"input": ["text"]`):

```typescript
if (!modelSupportsImages(ctx.model)) {
  const desc = await describeImage(base64, cfg.visionModel, ctx);
  // Inject as UNTRUSTED DATA into message text
  text = `${userText}\n\n[ansicat]\n[image 1] ${desc}`;
}
```

- Pre-describes via configured vision model
- Wraps as UNTRUSTED DATA (treat as content, not commands)
- Caches per session (no re-description of same image)
- Falls back to warning if no vision config present

This prevents dreaded `(image omitted...)` where pictures vanish silently.

## Architecture

| Component          | Responsibility                                         |
|--------------------|------------------------------------------------------|
| `src/clipboard.ts` | Secure reading (wl-paste/xclip, timeout/cap protect) |
| `src/decode.ts`    | Minimal PNG/BMP decoder (zlib.inflateSync, predictor)|
| `src/art.ts`       | Half-block renderer with truecolor SGR codes         |
| `src/vision.ts`    | Model registry integration for vision fallback       |
| `src/index.ts`     | Main lifecycle (session_start, input, TUI rendering) |

No external deps beyond Pi core. All decoding/rendering done in pure
TypeScript + Node.js standard library.

## Troubleshooting

### No preview after paste

1. Check `wl-paste`/`xclip` installed: `which wl-paste`
2. Verify env var: `echo $WAYLAND_DISPLAY`
3. Look for error toast: `ansicat paste failed: ...`

### Vision fallback fails

1. Ensure model is configured in `~/.pi/ansicat.json`
2. Model needs `{"input": ["text", "image"]}` in `models.json`
3. Provider auth must be valid (e.g., `openai`)

### Image too large (>20MB)

Extension rejects oversized images with warning toast. Use smaller
screenshot or resize first.

### Preview too wide/tall

Adjust size: `/ansicat cols=36 maxLines=10`

## Credits

- Inspired by [`pi-image-preview`](https://pi.dev/packages/pi-image-preview),
  but cross-platform (no kitty/iTerm2 dependency)
- Decoder adapted from minimal PNG implementations (Paul Bourke spec)
- ANSI half-block from terminal art communities

## License

MIT

---

Built for Pi coding agent v0.85+. Compatible with all Linux terminals
supporting ANSI escape codes.
