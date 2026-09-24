# pi-ansicat

Paste images with **ANSI half-block preview** and **vision fallback for text-only models**.  
Inline image preview for terminals without kitty/iTerm2 image protocol (foot, st, tmux, SSH).

## 🎯 Why

Most image paste extensions require kitty/iTerm2 graphics protocol. Terminals without that protocol (like `foot`) just show `[Image #N]` markers with no visual feedback — and worse, text-only models strip the image silently so you don't even see it when submitting.

`pi-ansicat` fixes both problems:

1. **Immediate ANSI preview** — renders a colorful half-block (`▀`) preview using plain terminal codes
2. **Vision fallback** — pre-describes images via a vision model before submitting to text-only models, preventing silent image loss

## 🚀 Install

### Via local path (development)

```bash
pi install path:./workspace/projects/pi-ansicat
```

Then `/reload` in Pi.

### Via npm (after publish)

```bash
pi install npm:pi-ansicat
```

**Note:** Conflicts with Pi's built-in paste on `Ctrl+V`. Clear keybinding in `~/.pi/agent/keybindings.json`:

```json
{ "app.clipboard.pasteImage": [] }
```

## ⚙️ Requirements

Linux only:

- **Wayland** → `wl-paste` (`sudo pacman -S wl-clipboard` / `apt install wl-clipboard`)
- **X11** → `xclip` (`sudo pacman -S xclip` / `apt install xclip`)

Auto-detects environment via `WAYLAND_DISPLAY` or `DISPLAY` variables.

## ✨ Usage

### Paste images with preview

```text
Ctrl+V
```

Result:

- **[Image #N]** placeholder inserted at cursor
- **ANSI half-block preview** rendered immediately below your message (48×14 default size)  
  Preview stays visible until you submit — perfect for confirming what got attached!

### Preview any file

```text
/ansi /path/to/image.png
```

Same ANSI preview for screenshot inspection, diagram review, etc.

### Adjust preview size live

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

| Field | Description | Default |
|-------|-------------|---------|
| `cols` | Preview width in terminal cells | 48 |
| `maxLines` | Maximum preview height | 14 |
| `vision.provider` | Vision model provider from registry | Fallback to `pi-vision.json` |
| `vision.model` | Vision model ID (must declare `{"input": ["text", "image"]}`) | N/A |

**Important:** The vision model is used **only** when pasting at text-only models. If omitted, falls back to `~/.pi/pi-vision.json` (shared with `@arhen/pi-core-vision`).

## 🔧 How it works

### 1. Clipboard read (secure)

- Uses `execFile` (not shell) → safe from command injection
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

Half-block character (`U+2580`) gives you two vertical pixels per cell → near-full-resolution preview in plain text mode.

### 3. Text-only model safety net
When submitting at a text-only model (declared `"input": ["text"]`):

```typescript
if (!modelSupportsImages(ctx.model)) {
  const desc = await describeImage(base64, cfg.visionModel, ctx);
  // Inject as UNTRUSTED DATA into message text
  text = `${userText}\n\n[ansicat vision descriptions]\n[image 1] ${desc}`;
}
```

- Pre-describes each image via configured vision model
- Wraps description as UNTRUSTED DATA (treat as content, not commands)
- Caches per session (no re-description of same image)
- Falls back to warning if no vision config present

This prevents the dreaded `(image omitted...)` where the picture vanishes silently.

## 🛠 Architecture

| Component | Responsibility |
|-----------|---------------|
| `src/clipboard.ts` | Secure clipboard reading (`wl-paste`/`xclip`, timeout/cap protection) |
| `src/decode.ts` | Minimal PNG/BMP decoder (zlib.inflateSync, predictor handling) |
| `src/art.ts` | Half-block ANSI renderer with truecolor SGR codes |
| `src/vision.ts` | Model registry integration for vision fallback |
| `src/index.ts` | Main extension lifecycle (`session_start`, `input` interceptor, TUI rendering) |

No external dependencies beyond Pi core extensions. All decoding/rendering done in pure TypeScript/Node.js standard library.

## 📋 Troubleshooting

### No preview appears after paste

1. Check `wl-paste`/`xclip` installed: `which wl-paste` or `which xclip`
2. Verify environment variable: `echo $WAYLAND_DISPLAY` or `echo $DISPLAY`
3. Look for error toast: `ansicat paste failed: ...`

### Vision fallback fails (`(vision model returned no description)`)

1. Ensure vision model is properly configured in `~/.pi/ansicat.json`
2. Model must declare `{"input": ["text", "image"]}` in `models.json`
3. Provider auth must be valid (for registry-based providers like `openai`)

### Image too large (>20MB)

Extension rejects oversized images with warning toast. Use a smaller screenshot or resize first.

### Preview too wide/tall

Adjust size: `/ansicat cols=36 maxLines=10`

## 🤝 Credits

- Inspired by [`pi-image-preview`](https://pi.dev/packages/pi-image-preview), but cross-platform (no kitty/iTerm2 dependency)
- Decoder adapted from minimal PNG implementations (Paul Bourke format spec)
- ANSI half-block technique from terminal art communities

## 📜 License

MIT

---

Built for Pi coding agent v0.85+. Compatible with all Linux terminals supporting ANSI escape codes.
