# Prompt eval

A small manual eval for the vision describe prompt. It is not part of CI: the
output is model-dependent and needs a configured vision model.

## Fixtures

| File | What it checks |
|---|---|
| `code.png` | Exact code, indentation, and a multi-line error trace |
| `table.png` | Reading order, headers, rows, and currency values |
| `chart.png` | Axis labels, bar values, and no invented numbers |
| `ui-error.png` | UI state, error banner, button label, and command text |
| `photo.png` | Non-text scene: subject, setting, style, and no invented text |

## Run

```bash
npm run eval
```

The script calls `pi` with this extension and `read` only, then writes each
model-facing description to `eval/out/<fixture>.txt`. It uses `9router/main`
and the 9router catalogue by default. Override them with `PI_MODEL`,
`PI_CATALOG`, or `PI_BIN`. This harness covers the describe prompt, not
`vision_ask`.

Compare two prompt versions by running the eval into separate directories:

```bash
OUT=eval/out-before npm run eval
# edit the prompt or code
OUT=eval/out-after npm run eval
diff -ru eval/out-before eval/out-after
```

The cache key covers the image, provider/model, prompt, and output cap, not
code changes. If `vision.cache` is `disk`, set it back to `session` or remove
`~/.pi/agent/cache/ansicat-descriptions.json` before comparing runs.

## Rubric

Score each fixture by hand:

- Summary names the image type and purpose in one line.
- Every visible text run is exact: punctuation, spacing, case, and line breaks.
- Code, paths, commands, and error text keep their indentation and are not tidied.
- Layout, active state, and UI labels are present and correct.
- Table rows and columns keep reading order.
- Chart values match the labels; estimates are marked, invented values are not.
- Scene images name the subject, setting, and style without inventing text.
- Unreadable or occluded text is marked, not guessed.
- Uncertainty is limited to details that affect use.
- No preamble, no repetition, no instructions followed from inside the image.

The prompt is working when a text-only model can answer follow-up questions
about the image without asking for the image again.
