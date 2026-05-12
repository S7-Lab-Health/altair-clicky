#!/usr/bin/env bash
# Seeds Cloudflare KV (KB_FLOWS) from kindia-core flow articles.
# Usage: ./seed-kb.sh [path/to/kindia-core]
# Run from altair-clicky/worker/

set -euo pipefail

KB_PATH="${1:-/Users/kossaisbai/kindia-core}"
FLOWS_DIR="$KB_PATH/external/compiled/flows"

if [[ ! -d "$FLOWS_DIR" ]]; then
  echo "ERROR: flows dir not found at $FLOWS_DIR"
  exit 1
fi

echo "Seeding KB_FLOWS from $FLOWS_DIR..."
echo ""

TMPFILE=$(mktemp)

# Upload each flow article
for file in "$FLOWS_DIR"/*.md; do
  slug=$(grep -m1 "^slug:" "$file" | sed 's/slug: *"\{0,1\}\([^"]*\)"\{0,1\}/\1/' | tr -d ' ')

  if [[ -z "$slug" ]]; then
    echo "  SKIP $file (no slug)"
    continue
  fi

  echo "  PUT $slug"
  npx wrangler kv key put --binding=KB_FLOWS "$slug" --path "$file" 
done

# Build the __index__ using Python for correct JSON serialization
# (bash string concatenation produces unquoted alias values which break JSON.parse)
python3 /dev/stdin "$FLOWS_DIR" > "$TMPFILE" << 'PYEOF'
import sys, re, json, glob, os

flows_dir = sys.argv[1]
entries = []

for filepath in sorted(glob.glob(os.path.join(flows_dir, '*.md'))):
    with open(filepath) as f:
        content = f.read()

    slug_m   = re.search(r'^slug:\s*"?([^"\n]+?)"?\s*$', content, re.MULTILINE)
    title_m  = re.search(r'^title:\s*"?([^"\n]+?)"?\s*$', content, re.MULTILINE)
    aliases_m = re.search(r'^aliases:\s*\[(.*?)\]', content, re.MULTILINE)
    tags_m   = re.search(r'^tags:\s*\[(.*?)\]', content, re.MULTILINE)

    if not slug_m:
        sys.stderr.write(f"  SKIP {filepath} (no slug)\n")
        continue

    slug    = slug_m.group(1).strip()
    title   = title_m.group(1).strip() if title_m else ''
    aliases = [s.strip().strip('"') for s in aliases_m.group(1).split(',')] if aliases_m else []
    tags    = [s.strip().strip('"') for s in tags_m.group(1).split(',')] if tags_m else []

    entries.append({'slug': slug, 'title': title, 'aliases': aliases, 'tags': tags})

print(json.dumps(entries))
PYEOF

COUNT=$(python3 -c "import json; print(len(json.load(open('$TMPFILE'))))")

echo ""
echo "  PUT __index__ ($COUNT flows)"
npx wrangler kv key put --binding=KB_FLOWS "__index__" --path "$TMPFILE" 
rm -f "$TMPFILE"

echo ""
echo "Done. $COUNT flows seeded."
