#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PI_BIN="${PI_BIN:-pi}"
PI_MODEL="${PI_MODEL:-9router/main}"
PI_CATALOG="${PI_CATALOG:-$HOME/.pi/agent/extensions/9router-catalog.ts}"
OUT="${OUT:-eval/out}"
mkdir -p "$OUT"
failed=0

extensions=(-e ./index.ts)
if [ -f "$PI_CATALOG" ]; then
  extensions=(-e "$PI_CATALOG" "${extensions[@]}")
fi

for image in eval/fixtures/*.png; do
  name="$(basename "$image")"
  echo "== $name =="
  "$PI_BIN" -ne "${extensions[@]}" -p --no-session --model "$PI_MODEL" --tools read --mode json "read $image" |
    python3 -c '
import json, sys
for line in sys.stdin:
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        continue
    if event.get("type") == "tool_execution_end" and event.get("toolName") == "read":
        for block in event["result"]["content"]:
            if block.get("type") == "text":
                print(block["text"])
' > "$OUT/$name.txt"
  printf '%s bytes\n' "$(wc -c < "$OUT/$name.txt")"
  if ! grep -q "ansicat vision description" "$OUT/$name.txt"; then
    echo "missing vision description for $name" >&2
    failed=1
  fi
done

echo "Wrote $OUT/*.txt"
if [ "$failed" -ne 0 ]; then
  echo "Some fixtures failed; check the vision config and provider." >&2
  exit 1
fi
